// Seam-1 acceptance for the particle cap (issue #12): the cap only decides
// which requests get a mesh — it must not change simulation results. Same
// seed, with and without the cap wired the way the web layer wires it
// (acquire at spawn via the request factory, release at every lifecycle
// terminal), the full observable trace has to be identical.
import { describe, expect, it } from "vitest";
import { SimRequest } from "../sim/request.js";
import { createSeededRng } from "../sim/rng.js";
import { STEP, makeWorld, wire } from "../sim/test-helpers.js";
import { createParticleBudget } from "./perf.js";

// Mirrors the survival run in determinism.test.js: mixed traffic through a
// realistic topology, long enough to cross a traffic shift, a malicious
// spike and random-event checks.
function runSeededGame(seed, { particleCap = null } = {}) {
    const { world, hooks } = makeWorld({ rng: createSeededRng(seed) });

    let hiddenPeak = 0;
    if (particleCap !== null) {
        const budget = createParticleBudget(particleCap);
        // Same shape as src/entities/Request.js: the factory consults the
        // budget at spawn; meshless requests are plain SimRequests.
        world.requestFactory = (w, type) => {
            const req = new SimRequest(w, type);
            req.particleVisible = budget.acquire();
            req.particleEpoch = budget.epoch;
            return req;
        };
        // Same shape as the game.js lifecycle hooks: every terminal
        // releases the request's slot.
        for (const k of [
            "onFinished",
            "onFailed",
            "onThrottled",
            "onBlocked",
            "onDiscarded",
        ]) {
            const prev = hooks[k];
            hooks[k] = (req, ...rest) => {
                budget.release(req.particleVisible, req.particleEpoch);
                hiddenPeak = Math.max(hiddenPeak, budget.hidden);
                prev(req, ...rest);
            };
        }
    }

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
        if (i % 4 === 0) {
            const burst = world.events.trafficBurstMultiplier > 1 ? 2 : 1;
            for (let n = 0; n < burst; n++) world.spawnRequest();
        }
        world.step(STEP);
        world.events.targetRPS();
    }

    return {
        hiddenPeak,
        trace: {
            time: world.time,
            stats: { ...world.stats },
            money: world.economy.money,
            reputation: world.economy.reputation,
            score: { ...world.economy.score },
            failures: { ...world.economy.failures },
            trafficDistribution: { ...world.trafficDistribution },
            events: hooks.events,
            health: world.services.map((s) => s.health),
        },
    };
}

describe("particle cap parity (seam 1)", () => {
    it("a tight cap changes nothing in the simulation under the same seed", () => {
        const uncapped = runSeededGame(20260718);
        // Cap of 1: nearly every concurrent request is aggregated — the
        // harshest possible visual budget.
        const capped = runSeededGame(20260718, { particleCap: 1 });

        // The cap actually bit (otherwise this test proves nothing).
        expect(capped.hiddenPeak).toBeGreaterThan(0);
        expect(capped.trace).toEqual(uncapped.trace);
    });
});
