// Named regression cases (issue #4): historical bugs in routing and the
// request lifecycle, rewritten as headless seam-1 tests so they can never
// come back silently.
import { describe, expect, it } from "vitest";
import { createRngStub } from "./rng.js";
import { makeWorld, runUntilDrained, wire } from "./test-helpers.js";

describe("historical regressions", () => {
    it("路由死循环: unroutable requests reach a terminal state in bounded time instead of circulating", () => {
        const { world, hooks } = makeWorld();
        const alb = world.addService("alb");
        const compute = world.addService("compute");
        const s3 = world.addService("s3");
        wire(world, "internet", alb);
        wire(world, alb, compute);
        wire(world, compute, s3); // no DB anywhere — WRITE/SEARCH can never be served

        world.spawnRequest("WRITE");
        world.spawnRequest("SEARCH");
        const elapsed = runUntilDrained(world, { maxSeconds: 30 });

        expect(world.requests).toHaveLength(0); // nothing left circling
        expect(elapsed).toBeLessThan(30);
        expect(world.stats.failed).toBe(2);
        expect(hooks.of("failed").map((ev) => ev.reason)).toEqual([
            "no-route",
            "no-route",
        ]);
    });

    it("Cache 吞掉无法投递的 STATIC (#88): compute bypasses a cache that could not deliver to storage", () => {
        // Cache wired only to the DB: a STATIC request routed into it would
        // die on the miss. Compute must use its direct S3 link instead.
        const { world, hooks } = makeWorld();
        const alb = world.addService("alb");
        const compute = world.addService("compute");
        const cache = world.addService("cache");
        const db = world.addService("db");
        const s3 = world.addService("s3");
        wire(world, "internet", alb);
        wire(world, alb, compute);
        wire(world, compute, cache);
        wire(world, cache, db); // cache has no storage link
        wire(world, compute, s3);

        world.spawnRequest("STATIC");
        runUntilDrained(world);

        expect(hooks.of("finished")).toEqual([
            expect.objectContaining({ type: "STATIC", via: "s3" }),
        ]);
        expect(cache.queue).toHaveLength(0);
        expect(cache.processing).toHaveLength(0);
    });

    it("Cache 吞掉无法投递的 STATIC (#88): a cache wired to storage still serves STATIC", () => {
        // Counter-case: with an S3 behind it the cache is a valid route and
        // a hit serves the request. Draw order: alb roll, compute roll,
        // cache roll, cache hit roll (STATIC hit rate 0.9).
        const { world, hooks } = makeWorld({ rng: createRngStub([0.5, 0.5, 0.5, 0.1]) });
        const alb = world.addService("alb");
        const compute = world.addService("compute");
        const cache = world.addService("cache");
        const s3 = world.addService("s3");
        wire(world, "internet", alb);
        wire(world, alb, compute);
        wire(world, compute, cache);
        wire(world, cache, s3);
        wire(world, compute, s3);

        world.spawnRequest("STATIC");
        runUntilDrained(world);

        expect(hooks.of("finished")).toEqual([
            expect.objectContaining({ type: "STATIC", via: "cache", cached: true }),
        ]);
    });

    it("请求泄漏: WAF-blocked requests are removed from the world, not stranded", () => {
        const { world } = makeWorld();
        const waf = world.addService("waf");
        const alb = world.addService("alb");
        wire(world, "internet", waf);
        wire(world, waf, alb);

        for (let i = 0; i < 5; i++) world.spawnRequest("MALICIOUS");
        runUntilDrained(world);

        // The historical leak: blocks bypassed removal, so world.requests
        // grew unbounded and every stale request kept ticking each frame.
        expect(world.requests).toHaveLength(0);
        expect(world.stats.maliciousBlocked).toBe(5);
        expect(waf.queue).toHaveLength(0);
        expect(waf.processing).toHaveLength(0);
    });

    it("禁用服务仍被路由: disabled services are skipped at entry and at every hop", () => {
        const { world, hooks } = makeWorld();
        const wafDown = world.addService("waf");
        const wafUp = world.addService("waf");
        const alb = world.addService("alb");
        const computeDown = world.addService("compute");
        const computeUp = world.addService("compute");
        const dbDown = world.addService("db");
        const dbUp = world.addService("db");
        wire(world, "internet", wafDown);
        wire(world, "internet", wafUp);
        wire(world, wafDown, alb);
        wire(world, wafUp, alb);
        wire(world, alb, computeDown);
        wire(world, alb, computeUp);
        for (const c of [computeDown, computeUp]) {
            wire(world, c, dbDown);
            wire(world, c, dbUp);
        }
        wafDown.isDisabled = true;
        computeDown.isDisabled = true;
        dbDown.isDisabled = true;

        for (let i = 0; i < 4; i++) world.spawnRequest("READ");
        runUntilDrained(world);

        // Everything completed via the healthy path; the disabled twins
        // never received a single request.
        expect(world.stats.completed).toBe(4);
        expect(hooks.of("finished").every((ev) => ev.via === "db")).toBe(true);
        for (const dead of [wafDown, computeDown, dbDown]) {
            expect(dead.queue).toHaveLength(0);
            expect(dead.processing).toHaveLength(0);
            expect(dead.incomingCount).toBe(0);
        }
    });
});
