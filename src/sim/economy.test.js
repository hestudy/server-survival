// Characterization tests (issue #5, M1-c): economic settlement through the
// public seam-1 interface. Every expected number below is pinned from the
// pre-migration web-layer logic (game.js updateScore / upkeep / repair /
// serverless billing) against src/config.js:
//   rewards  STATIC 0.5 / READ 0.8 / WRITE 1.2 / UPLOAD 1.5 / SEARCH 1.2
//   scores   STATIC 3 / READ 5 / WRITE 8 / UPLOAD 10 / SEARCH 5
//   SCORE_POINTS: success +0.1 rep, fail -1 rep, throttle -0.2 rep,
//   malicious passed -5 rep & $50 breach, blocked +10 score & $1 mitigation,
//   cache-hit bonus +20% reward.
// Money / score / reputation are asserted only through the economy's public
// state — never by poking at settlement internals.
import { describe, expect, it } from "vitest";
import { createRngStub } from "./rng.js";
import {
    makeWorld,
    runUntilDrained,
    stepFor,
    wire,
} from "./test-helpers.js";

// Baseline world for settlement tests: upkeep off so income/penalty numbers
// are exact, not entangled with per-frame maintenance drain.
function makeEconomyWorld(opts = {}) {
    const made = makeWorld(opts);
    made.economy = made.world.economy;
    made.economy.upkeepEnabled = false;
    return made;
}

function pipeline(world, ...types) {
    const services = types.map((t) => world.addService(t));
    let prev = "internet";
    for (const s of services) {
        wire(world, prev, s);
        prev = s;
    }
    return services;
}

describe("request income and scoring (COMPLETED)", () => {
    it("READ completion pays the reward and scores into the database bucket", () => {
        const { world, economy } = makeEconomyWorld();
        pipeline(world, "alb", "compute", "db");

        world.spawnRequest("READ");
        runUntilDrained(world);

        expect(economy.money).toBe(0.8);
        expect(economy.score).toEqual({
            total: 5,
            storage: 0,
            database: 5,
            maliciousBlocked: 0,
        });
        expect(economy.reputation).toBeCloseTo(100.1, 10);
        expect(economy.finances.income.requests).toBe(0.8);
        expect(economy.finances.income.total).toBe(0.8);
        expect(economy.finances.income.byType.READ).toBe(0.8);
        expect(economy.finances.income.countByType.READ).toBe(1);
    });

    it("STATIC and UPLOAD completions score into the storage bucket", () => {
        const { world, economy } = makeEconomyWorld();
        pipeline(world, "alb", "compute", "s3");

        world.spawnRequest("STATIC");
        world.spawnRequest("UPLOAD");
        runUntilDrained(world);

        expect(economy.money).toBeCloseTo(0.5 + 1.5, 10);
        expect(economy.score.storage).toBe(3 + 10);
        expect(economy.score.database).toBe(0);
        expect(economy.score.total).toBe(13);
        expect(economy.finances.income.countByType.STATIC).toBe(1);
        expect(economy.finances.income.countByType.UPLOAD).toBe(1);
    });

    it("a cache hit pays the reward with the +20% cache bonus", () => {
        // Draw order: alb fail roll, compute fail roll, cache fail roll,
        // then the cache-hit roll (STATIC's own hit rate is 0.9 — the 0.1
        // draw forces the hit).
        const { world, economy, hooks } = makeEconomyWorld({
            rng: createRngStub([0.5, 0.5, 0.5, 0.1]),
        });
        const [, compute] = pipeline(world, "alb", "compute", "cache");
        const cache = world.services[2];
        const s3 = world.addService("s3");
        wire(world, cache, s3);
        wire(world, compute, s3);

        world.spawnRequest("STATIC");
        runUntilDrained(world);

        expect(hooks.of("finished")).toEqual([
            expect.objectContaining({ via: "cache", cached: true }),
        ]);
        expect(economy.money).toBeCloseTo(0.5 * 1.2, 10);
        expect(economy.score.total).toBe(3);
    });
});

describe("reputation and score penalties", () => {
    it("a hard failure costs reputation, half the score, and a failure tally", () => {
        const { world, economy } = makeEconomyWorld();
        pipeline(world, "alb", "compute", "s3"); // no DB: WRITE can't be served

        world.spawnRequest("WRITE");
        runUntilDrained(world);

        expect(economy.reputation).toBe(99);
        expect(economy.score.total).toBe(-4); // -(8 / 2)
        expect(economy.failures.WRITE).toBe(1);
        expect(economy.money).toBe(0);
    });

    it("a throttled request only costs the soft reputation penalty", () => {
        const { world, economy } = makeEconomyWorld();
        const apigw = world.addService("apigw");
        apigw.config = { ...apigw.config, rateLimit: 1 };
        const alb = world.addService("alb");
        const compute = world.addService("compute");
        const db = world.addService("db");
        wire(world, "internet", apigw);
        wire(world, apigw, alb);
        wire(world, alb, compute);
        wire(world, compute, db);

        world.spawnRequest("READ");
        world.spawnRequest("READ");
        runUntilDrained(world);

        expect(world.stats.throttled).toBe(1);
        expect(world.stats.completed).toBe(1);
        // One success (+0.1), one throttle (-0.2); no score or failure tally.
        expect(economy.reputation).toBeCloseTo(100.1 - 0.2, 10);
        expect(economy.score.total).toBe(5);
        expect(economy.failures.READ).toBe(0);
        expect(economy.money).toBe(0.8);
    });

    it("a blocked attack scores and charges the mitigation cost", () => {
        const { world, economy } = makeEconomyWorld();
        pipeline(world, "waf", "alb");

        world.spawnRequest("MALICIOUS");
        runUntilDrained(world);

        expect(economy.score.maliciousBlocked).toBe(10);
        expect(economy.score.total).toBe(10);
        expect(economy.money).toBe(-1);
        expect(economy.finances.expenses.mitigation).toBe(1);
        expect(economy.reputation).toBe(100);
    });

    it("a passed attack costs the breach penalty and heavy reputation", () => {
        const { world, economy } = makeEconomyWorld();
        pipeline(world, "alb", "compute", "db"); // no WAF anywhere

        world.spawnRequest("MALICIOUS");
        runUntilDrained(world);

        expect(world.stats.maliciousPassed).toBe(1);
        expect(economy.reputation).toBe(95);
        expect(economy.money).toBe(-50);
        expect(economy.finances.expenses.breach).toBe(50);
        expect(economy.failures.MALICIOUS).toBe(1);
        expect(economy.score.total).toBe(0);
    });

    it("does not clamp reputation at settle time (the caller clamps per frame)", () => {
        const { world, economy } = makeEconomyWorld();
        pipeline(world, "alb", "compute", "db");

        world.spawnRequest("READ");
        runUntilDrained(world);

        expect(economy.reputation).toBeGreaterThan(100);
    });
});

describe("maintenance fees (upkeep)", () => {
    it("charges per-service upkeep per simulated second when enabled", () => {
        const { world, economy } = makeWorld();
        economy.upkeepScalingEnabled = () => false;
        world.addService("alb"); // upkeep 6/min

        stepFor(world, 10);

        expect(economy.money).toBeCloseTo(-(6 / 60) * 10, 10);
        expect(economy.finances.expenses.upkeep).toBeCloseTo(1, 10);
        expect(economy.finances.expenses.byService.alb).toBeCloseTo(1, 10);
    });

    it("charges nothing when upkeep is disabled", () => {
        const { world, economy } = makeWorld();
        economy.upkeepEnabled = false;
        world.addService("alb");

        stepFor(world, 10);

        expect(economy.money).toBe(0);
    });

    it("scales upkeep with elapsed game time (1x → 2x over scaleTime)", () => {
        const { world, economy } = makeWorld();
        world.addService("alb");

        // At t=0 the multiplier is ~1x…
        stepFor(world, 1);
        expect(economy.money).toBeCloseTo(-6 / 60, 3);

        // …and beyond scaleTime (600s) it saturates at 2x.
        world.time = 600;
        const before = economy.money;
        stepFor(world, 1);
        expect(economy.money - before).toBeCloseTo(-(6 / 60) * 2, 10);
    });

    it("applies the injected external cost multiplier on top of time scaling", () => {
        const { world, economy } = makeWorld();
        world.addService("alb");
        economy.externalCostMultiplier = () => 3;
        world.time = 700; // time factor saturated at 2x

        stepFor(world, 1);

        expect(economy.money).toBeCloseTo(-(6 / 60) * 2 * 3, 10);
    });

    it("skips the external multiplier entirely while scaling is off", () => {
        // Pre-migration behavior: outside survival mode getUpkeepMultiplier
        // returns 1.0 before ever reading the event multiplier.
        const { world, economy } = makeWorld();
        world.addService("alb");
        economy.upkeepScalingEnabled = () => false;
        economy.externalCostMultiplier = () => 3;

        stepFor(world, 1);

        expect(economy.money).toBeCloseTo(-6 / 60, 10);
    });
});

describe("serverless per-request billing", () => {
    it("charges per invocation on the success path, on top of upkeep semantics", () => {
        const { world, economy } = makeEconomyWorld();
        pipeline(world, "alb", "serverless", "db");

        world.spawnRequest("READ");
        runUntilDrained(world);

        expect(world.stats.completed).toBe(1);
        expect(economy.money).toBeCloseTo(0.8 - 0.03, 10);
        expect(economy.finances.expenses.upkeep).toBeCloseTo(0.03, 10);
        expect(economy.finances.expenses.byService.serverless).toBeCloseTo(0.03, 10);
    });

    it("still charges when the invocation fails (Lambda-style billing)", () => {
        // Health 20 (< criticalHealth 40) adds (1 - 0.2) * 0.5 = 0.4 fail
        // chance; the stubbed second draw (0.1) forces the processing failure.
        const { world, economy } = makeEconomyWorld({
            rng: createRngStub([0.9, 0.1]),
        });
        const [, serverless] = pipeline(world, "alb", "serverless", "db");
        serverless.health = 20;

        world.spawnRequest("READ");
        runUntilDrained(world);

        expect(world.stats.failed).toBe(1);
        // No reward — just the invocation charge (and the fail settlement).
        expect(economy.money).toBeCloseTo(-0.03, 10);
        expect(economy.finances.expenses.byService.serverless).toBeCloseTo(0.03, 10);
        expect(economy.reputation).toBe(99);
    });
});

describe("repair costs", () => {
    it("repairs at 15% of service cost and restores health", () => {
        const { world, economy } = makeEconomyWorld();
        const compute = world.addService("compute"); // cost 60 → repair $9
        compute.health = 50;
        economy.money = 100;

        expect(economy.repairService(compute)).toBe(true);
        expect(compute.health).toBe(100);
        expect(economy.money).toBe(91);
        expect(economy.finances.expenses.repairs).toBe(9);
        expect(economy.finances.expenses.byService.compute).toBe(9);
    });

    it("refuses to repair without funds and changes nothing", () => {
        const { world, economy } = makeEconomyWorld();
        const compute = world.addService("compute");
        compute.health = 50;
        economy.money = 5;

        expect(economy.repairService(compute)).toBe(false);
        expect(compute.health).toBe(50);
        expect(economy.money).toBe(5);
        expect(economy.finances.expenses.repairs).toBe(0);
    });

    it("refuses to repair a healthy service", () => {
        const { world, economy } = makeEconomyWorld();
        const compute = world.addService("compute");
        economy.money = 100;

        expect(economy.repairService(compute)).toBe(false);
        expect(economy.money).toBe(100);
    });
});

describe("auto-repair overhead", () => {
    it("charges 10% of total service cost per minute while enabled", () => {
        const { world, economy } = makeWorld();
        world.addService("alb"); // cost 50
        world.addService("compute"); // cost 60
        economy.upkeepEnabled = true;
        economy.autoRepairEnabled = true;

        const perSecond = economy.autoRepairUpkeepPerSecond();
        expect(perSecond).toBeCloseTo((110 * 0.1) / 60, 10);

        economy.chargeAutoRepair(2);
        expect(economy.money).toBeCloseTo(-perSecond * 2, 10);
        expect(economy.finances.expenses.autoRepair).toBeCloseTo(perSecond * 2, 10);
    });

    it("charges nothing when auto-repair is off or upkeep is disabled", () => {
        const { world, economy } = makeWorld();
        world.addService("alb");

        economy.autoRepairEnabled = false;
        economy.chargeAutoRepair(2);
        expect(economy.money).toBe(0);

        economy.autoRepairEnabled = true;
        economy.upkeepEnabled = false;
        economy.chargeAutoRepair(2);
        expect(economy.money).toBe(0);
    });
});

describe("historical regressions", () => {
    it("重复计分: each completed request settles the economy exactly once", () => {
        const { world, economy } = makeEconomyWorld();
        pipeline(world, "alb", "compute", "db");

        for (let i = 0; i < 3; i++) world.spawnRequest("READ");
        runUntilDrained(world);

        // The historical bug double-applied scoring per completion. With the
        // settlement inside the terminal transition it can only run once per
        // request: 3 READs are exactly 3 rewards, 3 scores, 3 counts.
        expect(world.stats.completed).toBe(3);
        expect(economy.money).toBeCloseTo(0.8 * 3, 10);
        expect(economy.score.total).toBe(5 * 3);
        expect(economy.finances.income.countByType.READ).toBe(3);
        expect(economy.reputation).toBeCloseTo(100 + 0.1 * 3, 10);
    });

    it("重复计分: blocked attacks tally score and mitigation exactly once each", () => {
        const { world, economy } = makeEconomyWorld();
        pipeline(world, "waf", "alb");

        for (let i = 0; i < 4; i++) world.spawnRequest("MALICIOUS");
        runUntilDrained(world);

        expect(world.stats.maliciousBlocked).toBe(4);
        expect(economy.score.maliciousBlocked).toBe(40);
        expect(economy.money).toBe(-4);
        expect(economy.finances.expenses.mitigation).toBe(4);
    });

    it("removed requests (player deletes a service) settle nothing", () => {
        const { world, economy } = makeEconomyWorld();
        pipeline(world, "alb", "compute", "db");

        const req = world.spawnRequest("READ");
        world.removeRequest(req);

        expect(world.stats.discarded).toBe(1);
        expect(economy.money).toBe(0);
        expect(economy.reputation).toBe(100);
        expect(economy.score.total).toBe(0);
    });
});
