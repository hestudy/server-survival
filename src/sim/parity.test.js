// RNG-seed 对拍 (issue #5 acceptance): the migrated economy must produce the
// same money / score / reputation as the pre-migration web layer. The
// reference settler below is a verbatim copy of the logic that lived in
// game.js before M1-c (updateScore, the per-service upkeep charge in
// Service.update, the serverless billing hook, and the auto-repair charge in
// the frame loop), stripped of DOM/sound side effects. Both settlers observe
// the exact same seeded simulation run; their books must agree.
import { describe, expect, it } from "vitest";
import { CONFIG, TRAFFIC_TYPES } from "../config.js";
import { createSeededRng } from "./rng.js";
import { SimWorld } from "./world.js";
import { STEP, wire } from "./test-helpers.js";

function makeReference(config) {
    const ref = {
        money: 0,
        reputation: 100,
        score: { total: 0, storage: 0, database: 0, maliciousBlocked: 0 },
        failures: { STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0 },
        finances: {
            income: {
                byType: { STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0 },
                countByType: { STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0, blocked: 0 },
                requests: 0,
                blocked: 0,
                total: 0,
            },
            expenses: {
                services: 0,
                upkeep: 0,
                repairs: 0,
                autoRepair: 0,
                byService: {},
                countByService: {},
            },
        },
    };

    // ---- verbatim from pre-M1-c game.js updateScore -------------------
    function updateScore(req, outcome) {
        const points = config.survival.SCORE_POINTS;
        const typeConfig = req.typeConfig || config.trafficTypes[req.type];

        if (outcome === "MALICIOUS_BLOCKED") {
            ref.score.maliciousBlocked += points.MALICIOUS_BLOCKED_SCORE;
            ref.score.total += points.MALICIOUS_BLOCKED_SCORE;

            const mitigationCost = points.MALICIOUS_MITIGATION_COST || 1.0;
            ref.money -= mitigationCost;
            ref.finances.expenses.mitigation =
                (ref.finances.expenses.mitigation || 0) + mitigationCost;
        } else if (
            req.type === TRAFFIC_TYPES.MALICIOUS &&
            outcome === "MALICIOUS_PASSED"
        ) {
            ref.reputation += points.MALICIOUS_PASSED_REPUTATION;
            ref.failures.MALICIOUS++;

            const breachPenalty = points.MALICIOUS_BREACH_PENALTY || 50.0;
            ref.money -= breachPenalty;
            ref.finances.expenses.breach =
                (ref.finances.expenses.breach || 0) + breachPenalty;
        } else if (outcome === "COMPLETED") {
            let reward = typeConfig.reward;
            const score = typeConfig.score;

            if (req.cached) {
                reward *= 1 + points.CACHE_HIT_BONUS;
            }

            if (typeConfig.destination === "s3" || typeConfig.destination === "cdn") {
                ref.score.storage += score;
            } else if (typeConfig.destination === "db") {
                ref.score.database += score;
            }

            ref.score.total += score;
            ref.money += reward;
            ref.finances.income.requests += reward;
            ref.finances.income.total += reward;
            const reqType = req.type || "STATIC";
            ref.finances.income.byType[reqType] =
                (ref.finances.income.byType[reqType] || 0) + reward;
            ref.finances.income.countByType[reqType] =
                (ref.finances.income.countByType[reqType] || 0) + 1;
            ref.reputation += points.SUCCESS_REPUTATION || 0.5;
        } else if (outcome === "THROTTLED") {
            ref.reputation += points.THROTTLED_REPUTATION || -0.2;
        } else if (outcome === "FAILED") {
            ref.reputation += points.FAIL_REPUTATION;
            ref.score.total -= (typeConfig.score || 5) / 2;
            if (ref.failures[req.type] !== undefined) {
                ref.failures[req.type]++;
            }
        }
    }

    // ---- verbatim from pre-M1-c game.js getUpkeepMultiplier (survival) --
    function upkeepMultiplier(gameTime) {
        if (!config.survival.upkeepScaling.enabled) return 1.0;
        const progress = Math.min(
            gameTime / config.survival.upkeepScaling.scaleTime,
            1.0
        );
        const base = config.survival.upkeepScaling.baseMultiplier;
        const max = config.survival.upkeepScaling.maxMultiplier;
        return base + (max - base) * progress;
    }

    // ---- verbatim from pre-M1-c Service.update upkeep block -------------
    function chargeUpkeep(service, dt, gameTime) {
        const multiplier = upkeepMultiplier(gameTime);
        const upkeepCost = (service.config.upkeep / 60) * dt * multiplier;
        ref.money -= upkeepCost;
        ref.finances.expenses.upkeep += upkeepCost;
        ref.finances.expenses.byService[service.type] =
            (ref.finances.expenses.byService[service.type] || 0) + upkeepCost;
    }

    // ---- verbatim from pre-M1-c game.js onServerlessCharge hook ---------
    function chargeServerless(service) {
        const cost = service.config.perRequestCost || 0;
        ref.money -= cost;
        ref.finances.expenses.upkeep += cost;
        ref.finances.expenses.byService.serverless =
            (ref.finances.expenses.byService.serverless || 0) + cost;
    }

    // ---- verbatim from pre-M1-c getAutoRepairUpkeep + frame-loop charge --
    function chargeAutoRepair(dt, services, autoRepairEnabled) {
        if (!autoRepairEnabled) return;
        const percent = config.survival.degradation?.autoRepairCostPercent || 0.1;
        const totalServiceCost = services.reduce((sum, s) => sum + s.config.cost, 0);
        const autoRepairCost = (totalServiceCost * percent) / 60;
        if (autoRepairCost > 0) {
            const cost = autoRepairCost * dt;
            ref.money -= cost;
            ref.finances.expenses.autoRepair += cost;
        }
    }

    return { ref, updateScore, chargeUpkeep, chargeServerless, chargeAutoRepair };
}

describe("economy parity with the pre-migration implementation", () => {
    it("agrees on money, score and reputation over a seeded mixed-traffic run", () => {
        const reference = makeReference(CONFIG);
        const { ref } = reference;

        const world = new SimWorld({
            rng: createSeededRng(20260717),
            hooks: {
                onFinished: (req) => reference.updateScore(req, "COMPLETED"),
                onFailed: (req) =>
                    reference.updateScore(
                        req,
                        req.type === TRAFFIC_TYPES.MALICIOUS
                            ? "MALICIOUS_PASSED"
                            : "FAILED"
                    ),
                onThrottled: (req) => reference.updateScore(req, "THROTTLED"),
                onBlocked: (req) => reference.updateScore(req, "MALICIOUS_BLOCKED"),
                onServerlessCharge: (service) => reference.chargeServerless(service),
            },
        });
        const economy = world.economy;
        economy.autoRepairEnabled = true;

        // A realistic mid-game architecture exercising every billing point:
        // WAF entry, gateway throttling, serverless per-request billing,
        // cache hits, storage and database destinations.
        const waf = world.addService("waf");
        const apigw = world.addService("apigw");
        apigw.config = { ...apigw.config, rateLimit: 8 };
        const alb = world.addService("alb");
        const compute = world.addService("compute");
        const serverless = world.addService("serverless");
        const cache = world.addService("cache");
        const db = world.addService("db");
        const s3 = world.addService("s3");
        wire(world, "internet", waf);
        wire(world, waf, apigw);
        wire(world, apigw, alb);
        wire(world, alb, compute);
        wire(world, alb, serverless);
        for (const c of [compute, serverless]) {
            wire(world, c, cache);
            wire(world, c, db);
            wire(world, c, s3);
        }
        wire(world, cache, db);
        wire(world, cache, s3);

        // ~15 rps of survival-mix traffic for 20 simulated seconds, then
        // drain. The reference books upkeep/auto-repair around each step the
        // same way the old frame loop did around its service updates.
        const stepOnce = () => {
            const gameTimeAfterStep = world.time + STEP;
            for (const s of world.services) {
                reference.chargeUpkeep(s, STEP, gameTimeAfterStep);
            }
            world.step(STEP);
            economy.chargeAutoRepair(STEP);
            reference.chargeAutoRepair(STEP, world.services, true);
        };

        for (let i = 0; i < 400; i++) {
            if (i % 4 === 0) world.spawnRequest();
            stepOnce();
        }
        let guard = 0;
        while (world.requests.length > 0 && guard++ < 2400) stepOnce();

        // Sanity: the run actually exercised the interesting paths.
        expect(world.requests).toHaveLength(0);
        expect(world.stats.completed).toBeGreaterThan(0);
        expect(world.stats.maliciousBlocked).toBeGreaterThan(0);

        expect(economy.money).toBeCloseTo(ref.money, 8);
        expect(economy.reputation).toBeCloseTo(ref.reputation, 8);
        expect(economy.score).toEqual(ref.score);
        expect(economy.failures).toEqual(ref.failures);
        expect(economy.finances.income.total).toBeCloseTo(ref.finances.income.total, 8);
        expect(economy.finances.income.countByType).toEqual(ref.finances.income.countByType);
        expect(economy.finances.expenses.upkeep).toBeCloseTo(ref.finances.expenses.upkeep, 8);
        expect(economy.finances.expenses.autoRepair).toBeCloseTo(
            ref.finances.expenses.autoRepair,
            8
        );
        expect(economy.finances.expenses.mitigation || 0).toBeCloseTo(
            ref.finances.expenses.mitigation || 0,
            8
        );
        expect(economy.finances.expenses.breach || 0).toBeCloseTo(
            ref.finances.expenses.breach || 0,
            8
        );
    });
});
