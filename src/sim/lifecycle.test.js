// Characterization tests: request lifecycle terminals — firewall
// interception, API-gateway throttling (soft fail), SQS queue buffering,
// queue-overflow hard fails, and the conservation invariant (every spawned
// request ends in exactly one terminal bucket; nothing leaks).
import { describe, expect, it } from "vitest";
import { createSeededRng } from "./rng.js";
import {
    STEP,
    makeWorld,
    runUntilDrained,
    stepFor,
    terminalTotal,
    wire,
} from "./test-helpers.js";

describe("firewall interception", () => {
    it("blocks MALICIOUS traffic at queue admission and lets everything else through", () => {
        const { world, hooks } = makeWorld();
        const waf = world.addService("waf");
        const alb = world.addService("alb");
        const compute = world.addService("compute");
        const db = world.addService("db");
        wire(world, "internet", waf);
        wire(world, waf, alb);
        wire(world, alb, compute);
        wire(world, compute, db);

        world.spawnRequest("MALICIOUS");
        world.spawnRequest("MALICIOUS");
        world.spawnRequest("MALICIOUS");
        world.spawnRequest("READ");
        runUntilDrained(world);

        expect(world.stats.maliciousBlocked).toBe(3);
        expect(world.stats.completed).toBe(1);
        expect(world.stats.maliciousPassed).toBe(0);
        // Blocked requests never occupy a processing slot on the WAF.
        expect(hooks.of("blocked")).toHaveLength(3);
    });
});

describe("API gateway rate limiting (throttle soft fail)", () => {
    function gatewayTopology(world, rateLimit) {
        const apigw = world.addService("apigw");
        apigw.config = { ...apigw.config, rateLimit };
        const alb = world.addService("alb");
        const compute = world.addService("compute");
        const db = world.addService("db");
        wire(world, "internet", apigw);
        wire(world, apigw, alb);
        wire(world, alb, compute);
        wire(world, compute, db);
        return apigw;
    }

    it("forwards up to the rate limit per second and throttles the excess", () => {
        const { world, hooks } = makeWorld();
        gatewayTopology(world, 2);

        for (let i = 0; i < 5; i++) world.spawnRequest("READ");
        runUntilDrained(world);

        expect(world.stats.throttled).toBe(3);
        expect(world.stats.completed).toBe(2);
        expect(hooks.of("throttled")).toHaveLength(3);
    });

    it("resets the rate window after one second", () => {
        const { world } = makeWorld();
        gatewayTopology(world, 2);

        for (let i = 0; i < 3; i++) world.spawnRequest("READ");
        stepFor(world, 1.5); // burst resolved, window rolled over
        for (let i = 0; i < 2; i++) world.spawnRequest("READ");
        runUntilDrained(world);

        expect(world.stats.throttled).toBe(1);
        expect(world.stats.completed).toBe(4);
    });
});

describe("queue buffering", () => {
    it("SQS absorbs a burst beyond compute capacity and compute drains it by pulling — nothing drops", () => {
        const { world } = makeWorld();
        const waf = world.addService("waf");
        const sqs = world.addService("sqs");
        const compute = world.addService("compute");
        const db = world.addService("db");
        wire(world, "internet", waf);
        wire(world, waf, sqs);
        wire(world, sqs, compute);
        wire(world, compute, db);

        for (let i = 0; i < 10; i++) world.spawnRequest("WRITE");

        // Track that the queue actually buffered and compute never exceeded
        // its processing capacity while draining.
        let sqsPeakHeld = 0;
        let computePeakProcessing = 0;
        let t = 0;
        while (world.requests.length > 0 && t < 60) {
            world.step(STEP);
            t += STEP;
            sqsPeakHeld = Math.max(sqsPeakHeld, sqs.queue.length + sqs.processing.length);
            computePeakProcessing = Math.max(computePeakProcessing, compute.processing.length);
        }

        expect(world.stats.completed).toBe(10);
        expect(world.stats.failed).toBe(0);
        expect(sqsPeakHeld).toBeGreaterThan(0);
        expect(computePeakProcessing).toBeLessThanOrEqual(compute.config.capacity);
    });

    it("hard-fails arrivals when the target queue is full (maxQueueSize)", () => {
        const { world, hooks } = makeWorld();
        const alb = world.addService("alb");
        const compute = world.addService("compute");
        compute.config = { ...compute.config, maxQueueSize: 1 };
        const db = world.addService("db");
        wire(world, "internet", alb);
        wire(world, alb, compute);
        wire(world, compute, db);

        for (let i = 0; i < 3; i++) world.spawnRequest("READ");
        runUntilDrained(world);

        const overflows = hooks.of("failed").filter((ev) => ev.reason === "queue-overflow");
        expect(overflows).toHaveLength(2);
        expect(world.stats.completed).toBe(1);
        expect(world.stats.failed).toBe(2);
    });
});

describe("terminal-state conservation (no request leaks)", () => {
    function realisticTopology(world) {
        const waf = world.addService("waf");
        const alb = world.addService("alb");
        const compute1 = world.addService("compute");
        const compute2 = world.addService("compute");
        const cache = world.addService("cache");
        const db = world.addService("db");
        const s3 = world.addService("s3");
        wire(world, "internet", waf);
        wire(world, waf, alb);
        wire(world, alb, compute1);
        wire(world, alb, compute2);
        for (const c of [compute1, compute2]) {
            wire(world, c, cache);
            wire(world, c, db);
            wire(world, c, s3);
        }
        wire(world, cache, db);
        wire(world, cache, s3);
    }

    it("every spawned request reaches exactly one terminal state, even under overload", () => {
        const { world, hooks } = makeWorld({ rng: createSeededRng(1234) });
        realisticTopology(world);

        // ~20 rps of mixed traffic drawn from the survival distribution —
        // deliberately more than this architecture can serve, so completions,
        // load failures, blocks and overflow all occur together.
        for (let i = 0; i < 200; i++) {
            world.spawnRequest();
            world.step(STEP);
        }
        runUntilDrained(world, { maxSeconds: 120 });

        expect(world.requests).toHaveLength(0);
        expect(world.stats.spawned).toBe(200);
        expect(terminalTotal(world)).toBe(200);
        expect(hooks.events).toHaveLength(200);
        for (const s of world.services) {
            expect(s.queue).toHaveLength(0);
            expect(s.processing).toHaveLength(0);
            expect(s.incomingCount).toBe(0);
        }
        // Sanity: the mix actually exercised several outcomes.
        expect(world.stats.completed).toBeGreaterThan(0);
        expect(world.stats.maliciousBlocked).toBeGreaterThan(0);
    });

    it("is deterministic under the same seeded RNG", () => {
        const run = () => {
            const { world } = makeWorld({ rng: createSeededRng(99) });
            realisticTopology(world);
            for (let i = 0; i < 100; i++) {
                world.spawnRequest();
                world.step(STEP);
            }
            runUntilDrained(world, { maxSeconds: 120 });
            return world.stats;
        };

        expect(run()).toEqual(run());
    });
});
