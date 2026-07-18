// Render-layer performance baseline (issue #12, seam: pure logic in
// src/render/perf.js). Two independent pieces:
//
// - Particle budget: caps how many request particles get a mesh. Purely a
//   render-side decision — the parity test (particle-cap.parity.test.js)
//   proves the simulation never notices it.
// - Quality governor: watches real frame times and steps a quality tier up
//   or down (降阶档位) with hysteresis so mid-fight fps dips degrade
//   smoothly and recovery upgrades never flap.
import { describe, expect, it } from "vitest";
import { createParticleBudget, createQualityGovernor } from "./perf.js";

describe("particle budget", () => {
    it("grants visible slots up to the cap, then aggregates the rest", () => {
        const budget = createParticleBudget(2);
        expect(budget.acquire()).toBe(true);
        expect(budget.acquire()).toBe(true);
        expect(budget.acquire()).toBe(false);
        expect(budget.visible).toBe(2);
        expect(budget.hidden).toBe(1);
    });

    it("releasing a visible slot frees it for the next request", () => {
        const budget = createParticleBudget(1);
        expect(budget.acquire()).toBe(true);
        expect(budget.acquire()).toBe(false);
        budget.release(true, budget.epoch);
        expect(budget.hidden).toBe(1);
        expect(budget.acquire()).toBe(true);
        expect(budget.visible).toBe(1);
    });

    it("releasing a hidden request only shrinks the aggregate count", () => {
        const budget = createParticleBudget(1);
        budget.acquire();
        budget.acquire();
        budget.release(false, budget.epoch);
        expect(budget.visible).toBe(1);
        expect(budget.hidden).toBe(0);
    });

    it("lowering the cap mid-game starves new requests but never evicts", () => {
        const budget = createParticleBudget(3);
        budget.acquire();
        budget.acquire();
        budget.acquire();
        budget.setCap(1);
        expect(budget.visible).toBe(3); // existing particles keep their mesh
        expect(budget.acquire()).toBe(false); // new ones aggregate
        budget.release(true, budget.epoch);
        budget.release(true, budget.epoch);
        budget.release(true, budget.epoch);
        expect(budget.acquire()).toBe(true); // back under the new cap
        expect(budget.acquire()).toBe(false);
    });

    it("reset() starts a new epoch; stale releases from the old game are ignored", () => {
        const budget = createParticleBudget(5);
        budget.acquire();
        const staleEpoch = budget.epoch;
        budget.reset(); // game restart while a 500ms death flash is pending
        budget.acquire();
        budget.release(true, staleEpoch); // the old request's delayed destroy
        expect(budget.visible).toBe(1);
        budget.release(true, budget.epoch);
        expect(budget.visible).toBe(0);
    });

    it("never underflows", () => {
        const budget = createParticleBudget(2);
        budget.release(true, budget.epoch);
        budget.release(false, budget.epoch);
        expect(budget.visible).toBe(0);
        expect(budget.hidden).toBe(0);
    });
});

// Governor test settings: degrade below 27fps sustained 2s, recover above
// 50fps sustained 4s, 3s cooldown between changes, 3 tiers (0..2).
function makeGovernor(overrides = {}) {
    const changes = [];
    const governor = createQualityGovernor({
        tierCount: 3,
        degradeBelowFps: 27,
        degradeAfterSeconds: 2,
        recoverAboveFps: 50,
        recoverAfterSeconds: 4,
        cooldownSeconds: 3,
        onChange: (tier) => changes.push(tier),
        ...overrides,
    });
    return { governor, changes };
}

// Feed `seconds` worth of frames at a constant fps.
function runFrames(governor, fps, seconds) {
    const dt = 1 / fps;
    for (let t = 0; t < seconds; t += dt) governor.frame(dt);
}

describe("quality governor", () => {
    it("stays at full quality while fps is healthy", () => {
        const { governor, changes } = makeGovernor();
        runFrames(governor, 60, 30);
        expect(governor.tier).toBe(0);
        expect(changes).toEqual([]);
    });

    it("a brief dip does not degrade — only sustained low fps does", () => {
        const { governor } = makeGovernor();
        runFrames(governor, 60, 5);
        runFrames(governor, 20, 0.5); // one hitch, shorter than degradeAfter
        runFrames(governor, 60, 5);
        expect(governor.tier).toBe(0);
    });

    it("sustained low fps degrades one tier at a time, down to the floor", () => {
        const { governor, changes } = makeGovernor();
        runFrames(governor, 20, 30);
        expect(governor.tier).toBe(2); // clamped at tierCount - 1
        expect(changes).toEqual([1, 2]);
    });

    it("cooldown spaces out consecutive degrades", () => {
        const { governor } = makeGovernor();
        // The smoothed fps crosses the threshold after ~0.8s, so the first
        // degrade lands near 2.8s; the second can't fire before the 3s
        // cooldown has elapsed on top of that.
        runFrames(governor, 20, 4);
        expect(governor.tier).toBe(1);
        runFrames(governor, 20, 3); // cooldown expires → second degrade
        expect(governor.tier).toBe(2);
    });

    it("mid-band fps (between thresholds) holds the current tier forever", () => {
        const { governor } = makeGovernor();
        runFrames(governor, 20, 10);
        const tier = governor.tier;
        runFrames(governor, 40, 60); // above degrade, below recover
        expect(governor.tier).toBe(tier);
    });

    it("sustained high fps recovers tiers back to full quality", () => {
        const { governor, changes } = makeGovernor();
        runFrames(governor, 20, 10); // degrade to floor
        runFrames(governor, 60, 60); // long healthy stretch
        expect(governor.tier).toBe(0);
        expect(changes[changes.length - 1]).toBe(0);
    });

    it("each degrade doubles the required recovery stretch (anti-flap)", () => {
        const { governor } = makeGovernor();
        runFrames(governor, 20, 10); // two degrades → recover needs 4s * 2^2
        runFrames(governor, 60, 8); // would have recovered at the base 4s
        expect(governor.tier).toBe(2);
        runFrames(governor, 60, 40);
        expect(governor.tier).toBe(0);
    });

    it("ignores pathological frame gaps (tab switch) instead of degrading", () => {
        const { governor } = makeGovernor();
        runFrames(governor, 60, 5);
        governor.frame(3); // rAF resumed after 3s in background
        governor.frame(0);
        governor.frame(-1);
        runFrames(governor, 60, 1);
        expect(governor.tier).toBe(0);
    });

    it("reports a smoothed fps estimate", () => {
        const { governor } = makeGovernor();
        runFrames(governor, 30, 10);
        expect(governor.fps).toBeGreaterThan(25);
        expect(governor.fps).toBeLessThan(35);
    });
});
