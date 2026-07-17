// Simulation-core economy (CONTEXT.md: 仿真核心 — 经济结算). Owns money,
// score, reputation, the failure tallies and the income/expense ledger, and
// applies every settlement rule: request income and scoring, reputation
// gains/losses, per-service maintenance fees with their time escalation,
// repair costs, the auto-repair overhead, and serverless per-request billing.
//
// The world invokes settle() from its lifecycle terminals and services
// charge upkeep/serverless billing through it, so seam-1 tests can assert
// all money/score/reputation changes through this public state. What stays
// outside: purchase/sell/upgrade transactions, the random-event system, and
// game-mode policy — the web layer injects those via the two policy hooks
// below until they migrate (M1-d).

// Zeroed ledger matching the restore-time default the web layer has always
// used (the richer of the two historical shapes: includes mitigation/breach
// and the blocked income counters).
export function defaultFinances() {
    const byService = {
        waf: 0, alb: 0, compute: 0, db: 0, s3: 0, cache: 0, sqs: 0,
        search: 0, replica: 0, apigw: 0, nosql: 0, cdn: 0, serverless: 0,
    };
    return {
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
            mitigation: 0,
            breach: 0,
            byService: { ...byService },
            countByService: { ...byService },
        },
    };
}

export class SimEconomy {
    constructor(world) {
        this.world = world;
        this.money = 0;
        this.reputation = 100;
        this.score = { total: 0, storage: 0, database: 0, maliciousBlocked: 0 };
        this.failures = {
            STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0,
        };
        this.finances = defaultFinances();

        this.upkeepEnabled = true;
        this.autoRepairEnabled = false;

        // Policy hooks. Time escalation of upkeep is the sim's business
        // (world.time drives it); whether it applies at all (survival vs
        // sandbox/campaign) and the random-event cost spike are still the
        // web layer's, injected here until the event system migrates.
        this.upkeepScalingEnabled = () =>
            world.config.survival.upkeepScaling.enabled;
        this.externalCostMultiplier = () => 1.0;
    }

    get _points() {
        return this.world.config.survival.SCORE_POINTS;
    }

    // Settlement for a request reaching a terminal state. Outcomes mirror
    // the historical web-layer contract: COMPLETED / FAILED / THROTTLED /
    // MALICIOUS_PASSED / MALICIOUS_BLOCKED. Reputation is deliberately not
    // clamped here — the caller clamps to 100 once per frame, and clamping
    // per settlement would change same-frame sequences.
    settle(outcome, req) {
        const points = this._points;
        const typeConfig = req.typeConfig || this.world.config.trafficTypes[req.type];

        if (outcome === "MALICIOUS_BLOCKED") {
            this.score.maliciousBlocked += points.MALICIOUS_BLOCKED_SCORE;
            this.score.total += points.MALICIOUS_BLOCKED_SCORE;

            const mitigationCost = points.MALICIOUS_MITIGATION_COST || 1.0;
            this.money -= mitigationCost;
            this.finances.expenses.mitigation =
                (this.finances.expenses.mitigation || 0) + mitigationCost;
        } else if (outcome === "MALICIOUS_PASSED") {
            this.reputation += points.MALICIOUS_PASSED_REPUTATION;
            this.failures.MALICIOUS++;

            const breachPenalty = points.MALICIOUS_BREACH_PENALTY || 50.0;
            this.money -= breachPenalty;
            this.finances.expenses.breach =
                (this.finances.expenses.breach || 0) + breachPenalty;
        } else if (outcome === "COMPLETED") {
            let reward = typeConfig.reward;
            const score = typeConfig.score;

            if (req.cached) {
                reward *= 1 + points.CACHE_HIT_BONUS;
            }

            if (typeConfig.destination === "s3" || typeConfig.destination === "cdn") {
                this.score.storage += score;
            } else if (typeConfig.destination === "db") {
                this.score.database += score;
            }

            this.score.total += score;
            this.money += reward;
            this.finances.income.requests += reward;
            this.finances.income.total += reward;
            const reqType = req.type || "STATIC";
            this.finances.income.byType[reqType] =
                (this.finances.income.byType[reqType] || 0) + reward;
            this.finances.income.countByType[reqType] =
                (this.finances.income.countByType[reqType] || 0) + 1;
            this.reputation += points.SUCCESS_REPUTATION || 0.5;
        } else if (outcome === "THROTTLED") {
            this.reputation += points.THROTTLED_REPUTATION || -0.2;
        } else if (outcome === "FAILED") {
            this.reputation += points.FAIL_REPUTATION;
            this.score.total -= (typeConfig.score || 5) / 2;
            if (this.failures[req.type] !== undefined) {
                this.failures[req.type]++;
            }
        }
    }

    // Maintenance-fee multiplier: 1x at t=0 scaling linearly to 2x at
    // scaleTime (600s), times the injected event multiplier. When scaling is
    // off (sandbox/campaign, or disabled in config) the event multiplier is
    // skipped too — that matches the historical early return.
    upkeepMultiplier() {
        if (!this.upkeepScalingEnabled()) return 1.0;

        const scaling = this.world.config.survival.upkeepScaling;
        const progress = Math.min(this.world.time / scaling.scaleTime, 1.0);
        const multiplier =
            scaling.baseMultiplier +
            (scaling.maxMultiplier - scaling.baseMultiplier) * progress;
        return multiplier * this.externalCostMultiplier();
    }

    // Per-service maintenance fee, charged from SimService.update each tick.
    chargeUpkeep(service, dt) {
        if (!this.upkeepEnabled) return;
        const upkeepCost =
            (service.config.upkeep / 60) * dt * this.upkeepMultiplier();
        this.money -= upkeepCost;
        this.finances.expenses.upkeep += upkeepCost;
        this.finances.expenses.byService[service.type] =
            (this.finances.expenses.byService[service.type] || 0) + upkeepCost;
    }

    // Lambda-style per-invocation billing, charged even on failures.
    chargeServerless(service) {
        const cost = service.config.perRequestCost || 0;
        this.money -= cost;
        this.finances.expenses.upkeep += cost;
        this.finances.expenses.byService.serverless =
            (this.finances.expenses.byService.serverless || 0) + cost;
    }

    repairCost(service) {
        const degradation = this.world.config.survival.degradation;
        return Math.ceil(
            service.config.cost * (degradation?.repairCostPercent || 0.15)
        );
    }

    // Manual repair: pay 15% of the purchase cost, restore full health.
    // Returns false (and changes nothing) when already healthy or broke.
    repairService(service) {
        if (service.health >= 100) return false;

        const cost = this.repairCost(service);
        if (this.money < cost) return false;

        this.money -= cost;
        this.finances.expenses.repairs += cost;
        this.finances.expenses.byService[service.type] =
            (this.finances.expenses.byService[service.type] || 0) + cost;
        service.health = 100;
        return true;
    }

    // Auto-repair overhead: 10% of the fleet's total purchase cost per
    // minute while the toggle is on.
    autoRepairUpkeepPerSecond() {
        if (!this.autoRepairEnabled) return 0;
        const percent =
            this.world.config.survival.degradation?.autoRepairCostPercent || 0.1;
        const totalServiceCost = this.world.services.reduce(
            (sum, s) => sum + s.config.cost,
            0
        );
        return (totalServiceCost * percent) / 60;
    }

    chargeAutoRepair(dt) {
        const perSecond = this.autoRepairUpkeepPerSecond();
        if (perSecond <= 0 || !this.upkeepEnabled) return;
        const cost = perSecond * dt;
        this.money -= cost;
        this.finances.expenses.autoRepair += cost;
    }
}
