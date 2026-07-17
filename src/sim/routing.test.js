// Characterization tests: destination selection per traffic type, and
// entry-point selection. These pin down the behavior the routing logic had
// in game.js/Service.js before the M1-b extraction — they describe what IS,
// not what ought to be.
import { describe, expect, it } from "vitest";
import { createRngStub } from "./rng.js";
import { makeWorld, runUntilDrained, wire } from "./test-helpers.js";

// internet → waf → alb → compute → { db, s3 }: the canonical minimal
// architecture that can serve every traffic type.
function baseTopology(world) {
    const waf = world.addService("waf");
    const alb = world.addService("alb");
    const compute = world.addService("compute");
    const db = world.addService("db");
    const s3 = world.addService("s3");
    wire(world, "internet", waf);
    wire(world, waf, alb);
    wire(world, alb, compute);
    wire(world, compute, db);
    wire(world, compute, s3);
    return { waf, alb, compute, db, s3 };
}

describe("destination selection for the six traffic types", () => {
    it.each([
        // STATIC's configured destination is "cdn", but with no CDN/cache in
        // the architecture it completes at S3 — storage-family destinations
        // are interchangeable (#88).
        ["STATIC", "s3"],
        ["READ", "db"],
        ["WRITE", "db"],
        ["UPLOAD", "s3"],
        // SEARCH falls back to the SQL DB when no search engine exists.
        ["SEARCH", "db"],
    ])("%s completes at %s in the base architecture", (type, expectedVia) => {
        const { world, hooks } = makeWorld();
        baseTopology(world);

        world.spawnRequest(type);
        runUntilDrained(world);

        expect(hooks.of("finished")).toEqual([
            expect.objectContaining({ type, via: expectedVia }),
        ]);
        expect(world.stats.completed).toBe(1);
    });

    it("MALICIOUS is blocked at the firewall and never completes", () => {
        const { world, hooks } = makeWorld();
        baseTopology(world);

        world.spawnRequest("MALICIOUS");
        runUntilDrained(world);

        expect(hooks.of("blocked")).toHaveLength(1);
        expect(hooks.of("finished")).toHaveLength(0);
        expect(world.stats.maliciousBlocked).toBe(1);
    });

    it("MALICIOUS that reaches compute (no firewall) counts as passed, not completed", () => {
        const { world, hooks } = makeWorld();
        const alb = world.addService("alb");
        const compute = world.addService("compute");
        const db = world.addService("db");
        wire(world, "internet", alb);
        wire(world, alb, compute);
        wire(world, compute, db);

        world.spawnRequest("MALICIOUS");
        runUntilDrained(world);

        expect(world.stats.maliciousPassed).toBe(1);
        expect(hooks.of("failed")).toEqual([
            expect.objectContaining({ type: "MALICIOUS", reason: "malicious-destination" }),
        ]);
    });

    it("SEARCH prefers a connected search engine over the SQL DB (and skips the cache, #167)", () => {
        const { world, hooks } = makeWorld();
        const { compute, db } = baseTopology(world);
        const cache = world.addService("cache");
        const search = world.addService("search");
        wire(world, compute, cache);
        wire(world, cache, db);
        wire(world, compute, search);

        world.spawnRequest("SEARCH");
        runUntilDrained(world);

        expect(hooks.of("finished")).toEqual([
            expect.objectContaining({ type: "SEARCH", via: "search" }),
        ]);
    });

    it("READ prefers replica over nosql over the SQL DB", () => {
        const { world, hooks } = makeWorld();
        const { compute, db } = baseTopology(world);
        const replica = world.addService("replica");
        const nosql = world.addService("nosql");
        wire(world, compute, replica);
        wire(world, replica, db);
        wire(world, compute, nosql);

        world.spawnRequest("READ");
        runUntilDrained(world);

        expect(hooks.of("finished")).toEqual([
            expect.objectContaining({ type: "READ", via: "replica" }),
        ]);
    });

    it("WRITE prefers nosql over the SQL DB", () => {
        const { world, hooks } = makeWorld();
        const { compute } = baseTopology(world);
        const nosql = world.addService("nosql");
        wire(world, compute, nosql);

        world.spawnRequest("WRITE");
        runUntilDrained(world);

        expect(hooks.of("finished")).toEqual([
            expect.objectContaining({ type: "WRITE", via: "nosql" }),
        ]);
    });

    it("a replica with no master DB fails READs instead of serving them", () => {
        const { world, hooks } = makeWorld();
        const { compute } = baseTopology(world);
        const replica = world.addService("replica"); // deliberately not wired to a db
        wire(world, compute, replica);

        world.spawnRequest("READ");
        runUntilDrained(world);

        expect(hooks.of("failed")).toEqual([
            expect.objectContaining({ type: "READ", reason: "no-route" }),
        ]);
    });

    it("STATIC served by the CDN on a cache hit, by its origin on a miss", () => {
        // Draw order on the CDN: load-failure roll, then cache-hit roll.
        const hit = makeWorld({ rng: createRngStub([0.5, 0.0]) });
        const miss = makeWorld({ rng: createRngStub([0.5, 0.999]) });

        for (const { world } of [hit, miss]) {
            const cdn = world.addService("cdn");
            const s3 = world.addService("s3");
            wire(world, "internet", cdn);
            wire(world, cdn, s3);
            world.spawnRequest("STATIC");
            runUntilDrained(world);
        }

        expect(hit.hooks.of("finished")).toEqual([
            expect.objectContaining({ via: "cdn", cached: true }),
        ]);
        expect(miss.hooks.of("finished")).toEqual([
            expect.objectContaining({ via: "s3", cached: false }),
        ]);
    });

    it("READ served from the memory cache on a hit, forwarded to the DB on a miss", () => {
        // Draw order: alb fail roll, compute fail roll, cache fail roll,
        // cache hit roll (READ hit rate 0.4).
        const hit = makeWorld({ rng: createRngStub([0.9, 0.9, 0.9, 0.1], 0.9) });
        const miss = makeWorld({ rng: createRngStub([], 0.9) });

        for (const { world } of [hit, miss]) {
            const alb = world.addService("alb");
            const compute = world.addService("compute");
            const cache = world.addService("cache");
            const db = world.addService("db");
            wire(world, "internet", alb);
            wire(world, alb, compute);
            wire(world, compute, cache);
            wire(world, cache, db);
            world.spawnRequest("READ");
            runUntilDrained(world);
        }

        expect(hit.hooks.of("finished")).toEqual([
            expect.objectContaining({ via: "cache", cached: true }),
        ]);
        expect(miss.hooks.of("finished")).toEqual([
            expect.objectContaining({ via: "db", cached: false }),
        ]);
    });
});

describe("entry-point selection", () => {
    it("STATIC prefers a CDN entry; everything else prefers the WAF", () => {
        const { world } = makeWorld();
        const cdn = world.addService("cdn");
        const waf = world.addService("waf");
        wire(world, "internet", cdn);
        wire(world, "internet", waf);

        expect(world.spawnRequest("STATIC").target).toBe(cdn);
        expect(world.spawnRequest("READ").target).toBe(waf);
        expect(world.spawnRequest("MALICIOUS").target).toBe(waf);
    });

    it("falls back WAF → API Gateway → any live entry", () => {
        const { world } = makeWorld();
        const apigw = world.addService("apigw");
        const alb = world.addService("alb");
        wire(world, "internet", apigw);
        wire(world, "internet", alb);

        expect(world.spawnRequest("READ").target).toBe(apigw);

        apigw.isDisabled = true;
        expect(world.spawnRequest("READ").target).toBe(alb);
    });

    it("round-robins across identical entry points", () => {
        const { world } = makeWorld();
        const waf1 = world.addService("waf");
        const waf2 = world.addService("waf");
        wire(world, "internet", waf1);
        wire(world, "internet", waf2);

        const targets = ["READ", "READ", "READ", "READ"].map(
            (t) => world.spawnRequest(t).target
        );
        expect(targets).toEqual([waf1, waf2, waf1, waf2]);
    });

    it("fails a request immediately when the internet has no connections", () => {
        const { world, hooks } = makeWorld();

        world.spawnRequest("READ");

        expect(world.requests).toHaveLength(0);
        expect(world.stats.failed).toBe(1);
        expect(hooks.of("failed")).toEqual([
            expect.objectContaining({ reason: "no-entry" }),
        ]);
    });

    it("spawns nothing when the traffic mix is all zeros (#174)", () => {
        const { world } = makeWorld({
            trafficDistribution: { STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0 },
        });

        expect(world.spawnRequest()).toBeNull();
        expect(world.stats.spawned).toBe(0);
    });
});
