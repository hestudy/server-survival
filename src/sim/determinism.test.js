// RNG injection closure (issue #6 acceptance): the simulation core contains
// zero direct randomness or wall-clock calls — proven by static check — and
// a full game under one seed (traffic, routing, economy AND the event
// system) replays identically.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "./rng.js";
import { STEP, makeWorld, wire } from "./test-helpers.js";

const simDir = dirname(fileURLToPath(import.meta.url));

describe("static check: the sim core draws no ambient randomness or time", () => {
    const sources = readdirSync(simDir).filter(
        (f) => f.endsWith(".js") && !f.endsWith(".test.js") && f !== "test-helpers.js"
    );

    it("covers the whole sim core", () => {
        expect(sources).toContain("world.js");
        expect(sources).toContain("service.js");
        expect(sources).toContain("events.js");
        expect(sources).toContain("economy.js");
        expect(sources).toContain("save.js");
        expect(sources).toContain("request.js");
        expect(sources).toContain("rng.js");
    });

    // Call-shaped patterns only: prose mentions of "Math.random" in comments
    // are fine, invoking it is not.
    const forbidden = [
        [/Math\.random\s*\(\s*\)/, "Math.random()"],
        [/Date\.now\s*\(\s*\)/, "Date.now()"],
        [/new\s+Date\s*\(/, "new Date("],
        [/performance\.now\s*\(\s*\)/, "performance.now()"],
    ];

    for (const file of sources) {
        it(`${file} has zero direct random/clock calls`, () => {
            const text = readFileSync(join(simDir, file), "utf8");
            for (const [pattern, label] of forbidden) {
                expect(
                    pattern.test(text),
                    `${file} must not call ${label} — inject rng / use world.time`
                ).toBe(false);
            }
        });
    }
});

// A full survival-style run: mixed traffic through a realistic topology,
// long enough (110 sim-seconds) to cross a traffic shift (40s), a malicious
// spike (blocked by the shift at 45s, lands at 90s), random-event checks
// (every 30s) and the first RPS milestone (60s). Returns a complete
// observable trace.
function runSeededGame(seed) {
    const { world, hooks } = makeWorld({ rng: createSeededRng(seed) });

    const waf = world.addService("waf");
    const alb = world.addService("alb");
    const compute = world.addService("compute");
    const cache = world.addService("cache");
    const db = world.addService("db");
    const s3 = world.addService("s3");
    wire(world, "internet", waf);
    wire(world, waf, alb);
    wire(world, alb, compute);
    wire(world, compute, cache);
    wire(world, compute, db);
    wire(world, compute, s3);
    wire(world, cache, db);
    wire(world, cache, s3);

    const steps = Math.round(110 / STEP);
    for (let i = 0; i < steps; i++) {
        // Spawn from the live distribution (so shifts and spikes change the
        // mix) at the event-scaled rate, like the web loop does.
        if (i % 4 === 0) {
            const burst = world.events.trafficBurstMultiplier > 1 ? 2 : 1;
            for (let n = 0; n < burst; n++) world.spawnRequest();
        }
        world.step(STEP);
        world.events.targetRPS(); // milestone tracking is part of the run
    }

    return {
        time: world.time,
        stats: { ...world.stats },
        money: world.economy.money,
        reputation: world.economy.reputation,
        score: { ...world.economy.score },
        failures: { ...world.economy.failures },
        trafficDistribution: { ...world.trafficDistribution },
        events: hooks.events,
        eventState: {
            maliciousSpikeActive: world.events.maliciousSpikeActive,
            trafficShiftActive: world.events.trafficShiftActive,
            activeEvent: world.events.activeEvent,
            costMultiplier: world.events.costMultiplier,
            trafficBurstMultiplier: world.events.trafficBurstMultiplier,
            currentMilestoneIndex: world.events.currentMilestoneIndex,
            rpsMultiplier: world.events.rpsMultiplier,
        },
        health: world.services.map((s) => s.health),
    };
}

describe("deterministic replay", () => {
    it("the same seed replays the whole game — events included — identically", () => {
        const first = runSeededGame(20260717);
        const second = runSeededGame(20260717);

        expect(second).toEqual(first);
        // The run actually exercised the event system, not just routing.
        const kinds = new Set(first.events.map((ev) => ev.e));
        expect(kinds).toContain("maliciousWarning");
        expect(kinds).toContain("spikeStart");
        expect(kinds).toContain("shiftStart");
        expect(kinds).toContain("rpsMilestone");
        expect(first.stats.spawned).toBeGreaterThan(100);
    });

    it("a different seed produces a different trace", () => {
        const first = runSeededGame(1);
        const second = runSeededGame(2);
        expect(second.events).not.toEqual(first.events);
    });
});
