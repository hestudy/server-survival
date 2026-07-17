// Event system at seam 1 (issue #6): given a seed and time advancement,
// trigger times, durations and end-of-event recovery are precisely
// assertable. Named regression cases at the bottom pin the historical bugs
// 「流量切换崩溃」「事件计时器异常」「outage 传送」「spike 防护」.
import { describe, expect, it } from "vitest";
import { CONFIG } from "../config.js";
import { createRngStub } from "./rng.js";
import { STEP, makeWorld, stepFor } from "./test-helpers.js";

// Events fire on the step that crosses their threshold, and float
// accumulation can push both a start and its dependent end one step late —
// so a recorded sim-time stamp may trail the scheduled moment by up to two
// steps.
function expectNear(actual, expected) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2 * STEP + 1e-9);
}

// Deep-merge helper: override individual survival subsystems while keeping
// the rest of the shipped config (services, traffic types, scoring).
function survivalConfig(overrides) {
    return { ...CONFIG, survival: { ...CONFIG.survival, ...overrides } };
}

const OFF = { enabled: false };

// Isolate one event subsystem: everything else off.
function onlyConfig(overrides) {
    return survivalConfig({
        maliciousSpike: OFF,
        trafficShift: OFF,
        randomEvents: OFF,
        ...overrides,
    });
}

describe("malicious spike (DDoS wave)", () => {
    const config = onlyConfig({
        maliciousSpike: {
            enabled: true,
            interval: 10,
            duration: 4,
            maliciousPercent: 0.5,
            warningTime: 2,
        },
    });

    it("warns, starts and ends on the configured cycle, swapping the traffic mix", () => {
        const { world, hooks } = makeWorld({ config });
        const original = { ...world.trafficDistribution };

        stepFor(world, 9);
        expect(hooks.of("maliciousWarning")).toHaveLength(1);
        expectNear(hooks.of("maliciousWarning")[0].t, 8);
        expect(world.events.maliciousSpikeActive).toBe(false);

        stepFor(world, 3); // t = 12, spike active since t = 10
        expect(hooks.of("spikeStart")).toHaveLength(1);
        expectNear(hooks.of("spikeStart")[0].t, 10);
        expect(world.events.maliciousSpikeActive).toBe(true);
        expect(world.trafficDistribution.MALICIOUS).toBeCloseTo(0.5, 10);
        // Non-malicious share rescaled proportionally: STATIC 0.3/0.8 * 0.5.
        expect(world.trafficDistribution.STATIC).toBeCloseTo(0.1875, 10);

        stepFor(world, 3); // t = 15, spike over since t = 14
        expect(hooks.of("spikeEnd")).toHaveLength(1);
        expectNear(hooks.of("spikeEnd")[0].t, 14);
        expect(world.events.maliciousSpikeActive).toBe(false);
        expect(world.trafficDistribution).toEqual(original);
    });

    it("spike 防护 (named regression): a 100% malicious mix survives the spike without NaN", () => {
        const { world } = makeWorld({
            config,
            trafficDistribution: {
                STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0, MALICIOUS: 1,
            },
        });

        stepFor(world, 11); // spike active
        expect(world.events.maliciousSpikeActive).toBe(true);
        for (const [type, share] of Object.entries(world.trafficDistribution)) {
            expect(Number.isFinite(share), `${type} share must stay finite`).toBe(true);
        }
        expect(world.trafficDistribution.MALICIOUS).toBe(1);

        stepFor(world, 4); // spike over
        expect(world.trafficDistribution.MALICIOUS).toBe(1);
    });
});

describe("traffic shift", () => {
    const config = onlyConfig({
        trafficShift: {
            ...CONFIG.survival.trafficShift,
            enabled: true,
            interval: 5,
            duration: 3,
        },
    });

    it("starts at the interval, applies the rng-chosen shift, restores after the duration", () => {
        // First draw picks shifts[0]; there is no other randomness in an
        // empty world.
        const { world, hooks } = makeWorld({ config, rng: createRngStub([0]) });
        const original = { ...world.trafficDistribution };
        const shift = config.survival.trafficShift.shifts[0];

        stepFor(world, 6); // t = 6, shift active since t = 5
        expect(hooks.of("shiftStart")).toHaveLength(1);
        expect(hooks.of("shiftStart")[0]).toMatchObject({ name: shift.name });
        expectNear(hooks.of("shiftStart")[0].t, 5);
        expect(world.events.currentShift).toBe(shift);
        expect(world.trafficDistribution).toEqual(shift.distribution);

        stepFor(world, 3); // t = 9, shift over since t = 8
        expect(hooks.of("shiftEnd")).toHaveLength(1);
        expectNear(hooks.of("shiftEnd")[0].t, 8);
        expect(world.events.currentShift).toBe(null);
        expect(world.trafficDistribution).toEqual(original);
    });

    it("流量切换崩溃 (named regression): shifts carry only {name, distribution} and start cleanly", () => {
        // The historical crash: the web layer referenced shift.type, which no
        // shipped shift has, throwing on every shift start. The sim hands the
        // hook the shift itself; its display name is the contract.
        const { world, hooks } = makeWorld({ config, rng: createRngStub([0]) });
        const shift = config.survival.trafficShift.shifts[0];
        expect(shift.type).toBeUndefined();
        expect(Object.keys(shift).sort()).toEqual(["distribution", "name"]);

        stepFor(world, 6);
        expect(hooks.of("shiftStart")).toEqual([
            expect.objectContaining({ name: shift.name }),
        ]);
        expect(typeof hooks.of("shiftStart")[0].name).toBe("string");
        expect(hooks.of("shiftStart")[0].name.length).toBeGreaterThan(0);
    });

    it("事件计时器异常 (named regression): a shift delayed by a spike still runs its full duration", () => {
        // Spike is active on the shift's scheduled start (t=12); the shift
        // must begin when the spike ends (t=15) and run its full 6 seconds,
        // not end at the absolute interval+duration mark (t=18).
        const config = onlyConfig({
            maliciousSpike: {
                enabled: true,
                interval: 10,
                duration: 5,
                maliciousPercent: 0.5,
                warningTime: 1,
            },
            trafficShift: {
                ...CONFIG.survival.trafficShift,
                enabled: true,
                interval: 12,
                duration: 6,
            },
        });
        const { world, hooks } = makeWorld({ config, rng: createRngStub([0]) });

        stepFor(world, 25);

        const start = hooks.of("shiftStart")[0];
        const end = hooks.of("shiftEnd")[0];
        expectNear(start.t, 15); // waited out the spike
        expectNear(end.t, 21);
        expect(end.t - start.t).toBeGreaterThan(5.9); // full duration, not ~0s or ~3s
    });
});

describe("random events", () => {
    // checkInterval 5 so tests stay short; single-type lists force the type.
    function randomEventsConfig(types) {
        return onlyConfig({
            randomEvents: {
                enabled: true,
                minInterval: 15,
                maxInterval: 45,
                checkInterval: 5,
                types,
            },
        });
    }
    // Draws: trigger roll (< 0.3), then type pick.
    const triggerRng = () => createRngStub([0.1, 0]);

    it("COST_SPIKE doubles the upkeep multiplier for 30 sim-seconds", () => {
        const { world, hooks, economy } = makeWorld({
            config: randomEventsConfig(["COST_SPIKE"]),
            rng: triggerRng(),
        });

        stepFor(world, 6); // triggered at t = 5
        expect(hooks.of("eventStart")).toEqual([
            expect.objectContaining({ type: "COST_SPIKE" }),
        ]);
        expectNear(hooks.of("eventStart")[0].t, 5);
        expect(world.events.costMultiplier).toBe(2.0);
        // The economy consumes the multiplier without any web-layer wiring.
        const scaling = 1 + (world.time / 600) * 1.0;
        expect(economy.upkeepMultiplier()).toBeCloseTo(scaling * 2.0, 6);

        stepFor(world, 30); // t = 36, event over since t = 35
        expect(hooks.of("eventEnd")).toEqual([
            expect.objectContaining({ type: "COST_SPIKE" }),
        ]);
        expectNear(hooks.of("eventEnd")[0].t, 35);
        expect(world.events.costMultiplier).toBe(1.0);
        // Later checks while the event was active never double-triggered.
        expect(hooks.of("eventStart")).toHaveLength(1);
    });

    it("CAPACITY_DROP halves effective capacity on every service, then restores it", () => {
        const { world } = makeWorld({
            config: randomEventsConfig(["CAPACITY_DROP"]),
            rng: triggerRng(),
        });
        const alb = world.addService("alb");
        const db = world.addService("db");
        const fullCapacity = alb.getEffectiveCapacity();

        stepFor(world, 6);
        expect(alb.tempCapacityReduction).toBe(0.5);
        expect(db.tempCapacityReduction).toBe(0.5);
        expect(alb.getEffectiveCapacity()).toBe(
            Math.max(1, Math.floor(fullCapacity * 0.5))
        );

        stepFor(world, 30);
        expect(alb.tempCapacityReduction).toBe(1.0);
        expect(alb.getEffectiveCapacity()).toBe(fullCapacity);
    });

    it("TRAFFIC_BURST triples the spawn multiplier, then restores it", () => {
        const { world } = makeWorld({
            config: randomEventsConfig(["TRAFFIC_BURST"]),
            rng: triggerRng(),
        });

        stepFor(world, 6);
        expect(world.events.trafficBurstMultiplier).toBe(3.0);
        stepFor(world, 30);
        expect(world.events.trafficBurstMultiplier).toBe(1.0);
    });

    it("SERVICE_OUTAGE disables an rng-chosen non-WAF service and re-enables it at the end", () => {
        const { world, hooks } = makeWorld({
            config: randomEventsConfig(["SERVICE_OUTAGE"]),
            // trigger roll, type pick, target pick (0 → first non-WAF)
            rng: createRngStub([0.1, 0, 0]),
        });
        const waf = world.addService("waf");
        const alb = world.addService("alb");
        const db = world.addService("db");

        stepFor(world, 6);
        expect(hooks.of("eventStart")).toEqual([
            expect.objectContaining({ type: "SERVICE_OUTAGE", serviceId: alb.id }),
        ]);
        expect(alb.isDisabled).toBe(true);
        expect(waf.isDisabled).toBeFalsy();
        expect(db.isDisabled).toBeFalsy();
        expect(world.events.outageServiceId).toBe(alb.id);

        stepFor(world, 30);
        expect(alb.isDisabled).toBe(false);
        expect(world.events.outageServiceId).toBe(null);
    });

    it("outage 传送 (named regression): pausing and resuming keeps the outage on the same service", () => {
        // Historical bug: pause→resume re-rolled the outage target, letting
        // the outage "teleport" to a different service. Event timing now
        // rides the sim clock, so a pause (no time advancing) changes
        // nothing: same target, same scheduled end.
        const { world, hooks } = makeWorld({
            config: randomEventsConfig(["SERVICE_OUTAGE"]),
            // After the three trigger draws, every draw returns ~1 — a
            // re-roll of the target would flip to the second candidate.
            rng: createRngStub([0.1, 0, 0]),
        });
        const alb = world.addService("alb");
        const db = world.addService("db");

        stepFor(world, 6); // outage on alb since t = 5
        expect(alb.isDisabled).toBe(true);

        for (let i = 0; i < 20; i++) world.step(0); // pause: time never advances

        expect(alb.isDisabled).toBe(true);
        expect(db.isDisabled).toBeFalsy();

        stepFor(world, 25); // resume; t = 31, event still active
        expect(alb.isDisabled).toBe(true);
        expect(db.isDisabled).toBeFalsy();
        expect(world.events.outageServiceId).toBe(alb.id);

        stepFor(world, 5); // t = 36, event over since t = 35 sim time
        expect(alb.isDisabled).toBe(false);
        expectNear(hooks.of("eventEnd")[0].t, 35);
        expect(hooks.of("eventStart")).toHaveLength(1); // never re-triggered
    });
});

describe("RPS milestone acceleration", () => {
    it("applies the milestone multiplier and announces each milestone exactly once", () => {
        const { world, hooks } = makeWorld();
        const base = (t) =>
            CONFIG.survival.baseRPS + Math.log(1 + t / 20) * 2.2 + t * 0.008;

        world.time = 30;
        expect(world.events.targetRPS()).toBeCloseTo(base(30), 10);
        expect(hooks.of("rpsMilestone")).toHaveLength(0);

        world.time = 61; // past the first milestone (60s → 1.3x)
        expect(world.events.targetRPS()).toBeCloseTo(base(61) * 1.3, 10);
        expect(hooks.of("rpsMilestone")).toEqual([
            expect.objectContaining({ time: 60, multiplier: 1.3, index: 0 }),
        ]);
        expect(world.events.rpsMultiplier).toBe(1.3);
        expect(world.events.currentMilestoneIndex).toBe(1);

        world.events.targetRPS(); // same milestone, no re-announcement
        expect(hooks.of("rpsMilestone")).toHaveLength(1);

        world.time = 121; // second milestone (120s → 1.6x)
        expect(world.events.targetRPS()).toBeCloseTo(base(121) * 1.6, 10);
        expect(hooks.of("rpsMilestone")).toHaveLength(2);
        expect(world.events.currentMilestoneIndex).toBe(2);
    });
});

describe("mode gating and reset", () => {
    it("the enabled policy freezes the whole event system", () => {
        const { world, hooks } = makeWorld({
            config: survivalConfig({
                maliciousSpike: { ...CONFIG.survival.maliciousSpike, interval: 5, warningTime: 1 },
                trafficShift: { ...CONFIG.survival.trafficShift, interval: 5 },
                randomEvents: { ...CONFIG.survival.randomEvents, checkInterval: 5 },
            }),
            rng: createRngStub([0.1, 0]),
        });
        world.events.enabled = () => false;
        const original = { ...world.trafficDistribution };

        stepFor(world, 20);

        expect(hooks.events.filter((ev) => ev.e !== "finished")).toEqual([]);
        expect(world.trafficDistribution).toEqual(original);
        expect(world.events.maliciousSpikeTimer).toBe(0);
        expect(world.events.trafficShiftTimer).toBe(0);
        expect(world.events.randomEventTimer).toBe(0);
    });

    it("reset() returns every event effect and timer to the initial state", () => {
        const { world } = makeWorld({
            config: onlyConfig({
                randomEvents: {
                    enabled: true, minInterval: 15, maxInterval: 45,
                    checkInterval: 5, types: ["COST_SPIKE"],
                },
            }),
            rng: createRngStub([0.1, 0]),
        });
        stepFor(world, 6);
        expect(world.events.activeEvent).toBe("COST_SPIKE");

        world.events.reset();

        expect(world.events.activeEvent).toBe(null);
        expect(world.events.costMultiplier).toBe(1.0);
        expect(world.events.trafficBurstMultiplier).toBe(1.0);
        expect(world.events.randomEventTimer).toBe(0);
        expect(world.events.maliciousSpikeActive).toBe(false);
        expect(world.events.trafficShiftActive).toBe(false);
        expect(world.events.currentMilestoneIndex).toBe(0);
        expect(world.events.rpsMultiplier).toBe(1.0);
    });
});

describe("service health degradation", () => {
    it("decays health under sustained load and recovers it when idle", () => {
        const { world } = makeWorld({ config: onlyConfig({}) });
        const db = world.addService("db");
        world.connect("internet", db.id);

        for (let t = 0; t < 10; t += STEP) {
            world.spawnRequest("WRITE");
            world.step(STEP);
        }
        expect(db.health).toBeLessThan(100);

        // Drain, then idle: the passive regen (autoRepairRate) kicks in.
        let guard = 0;
        while (world.requests.length > 0 && guard++ < 1200) world.step(STEP);
        const drained = db.health;
        stepFor(world, 5);
        expect(db.health).toBeGreaterThan(drained);
        expect(db.health).toBeCloseTo(
            Math.min(100, drained + CONFIG.survival.degradation.autoRepairRate * 5),
            1
        );
    });

    it("the degradation policy hook can freeze health entirely (non-survival modes)", () => {
        const { world } = makeWorld({ config: onlyConfig({}) });
        world.degradationEnabled = () => false;
        const db = world.addService("db");
        world.connect("internet", db.id);

        for (let t = 0; t < 5; t += STEP) {
            world.spawnRequest("WRITE");
            world.step(STEP);
        }
        expect(db.health).toBe(100);
    });

    it("active auto-repair heals 5 hp/s on top of the idle regen", () => {
        const { world, economy } = makeWorld({ config: onlyConfig({}) });
        const db = world.addService("db");
        economy.autoRepairEnabled = true;
        db.health = 40;

        stepFor(world, 2);

        // 2 hp/s idle regen + 5 hp/s auto-repair over 2 seconds.
        expect(db.health).toBeCloseTo(54, 6);

        db.health = 99.9;
        stepFor(world, 1);
        expect(db.health).toBe(100); // capped
    });
});
