// Seam-1 acceptance for the particle cap (issue #12): the cap only decides
// which requests get a mesh — it must not change simulation results. Same
// seed, with and without the cap wired the way the web layer wires it
// (acquire at spawn via the request factory, release at every lifecycle
// terminal), the full observable trace has to be identical.
import { describe, expect, it } from "vitest";
import { SimRequest } from "../sim/request.js";
import { createSeededRng } from "../sim/rng.js";
import { makeWorld, runSurvivalScenario } from "../sim/test-helpers.js";
import { createParticleBudget } from "./perf.js";

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

    runSurvivalScenario(world);

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
