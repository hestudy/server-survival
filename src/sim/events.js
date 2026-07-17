// Simulation-core event system (CONTEXT.md: 仿真核心 — 事件系统). Owns the
// malicious spike (DDoS wave) cycle, periodic traffic shifts, the random
// event roster (COST_SPIKE / CAPACITY_DROP / TRAFFIC_BURST / SERVICE_OUTAGE)
// and the RPS milestone acceleration. All randomness comes from world.rng;
// all timing rides the sim clock (world.time / the dt fed to update) — never
// the wall clock — so a seeded run replays deterministically and pausing the
// simulation freezes every event in place (the root fix for the historical
// 「outage 传送」 pause/resume bug).
//
// The web layer presents through hooks only: warnings, indicator bars,
// sounds and mesh opacity live outside; whether the system runs at all in
// the current game mode is injected via the `enabled` policy.

export class SimEvents {
    constructor(world) {
        this.world = world;

        // Game-mode policy (survival, or campaign levels that opt into
        // survival shifts). Headless worlds default to "on".
        this.enabled = () => true;

        this.reset();
    }

    reset() {
        // Malicious spike (恶意波次) state.
        this.maliciousSpikeTimer = 0;
        this.maliciousSpikeActive = false;
        this.normalTrafficDist = null;

        // Traffic shift (流量模式切换) state.
        this.trafficShiftTimer = 0;
        this.trafficShiftActive = false;
        this.currentShift = null;
        this.originalTrafficDist = null;

        // Random event state. eventEndTime/eventDuration are sim seconds.
        this.randomEventTimer = 0;
        this.activeEvent = null;
        this.eventEndTime = 0;
        this.eventDuration = 0;
        this.outageServiceId = null;
        this.costMultiplier = 1.0;
        this.trafficBurstMultiplier = 1.0;

        // RPS milestone tracking.
        this.currentMilestoneIndex = 0;
        this.rpsMultiplier = 1.0;
    }

    // Advance every event subsystem by dt sim-seconds. Subsystem order
    // (spike → shift → random events) mirrors the historical frame order.
    update(dt) {
        if (!this.enabled()) return;
        this._updateMaliciousSpike(dt);
        this._updateTrafficShift(dt);
        this._updateRandomEvents(dt);
    }

    // ---- Malicious spike ----------------------------------------------

    _updateMaliciousSpike(dt) {
        const config = this.world.config.survival.maliciousSpike;
        if (!config?.enabled) return;

        this.maliciousSpikeTimer += dt;

        const { interval, duration, warningTime } = config;
        const cycleTime = this.maliciousSpikeTimer % interval;

        if (
            cycleTime >= interval - warningTime &&
            cycleTime < interval - warningTime + dt &&
            !this.maliciousSpikeActive
        ) {
            this.world.hooks.onMaliciousWarning?.();
        }

        if (cycleTime < dt && this.maliciousSpikeTimer > warningTime) {
            this.startMaliciousSpike();
        }

        if (
            this.maliciousSpikeActive &&
            cycleTime >= duration &&
            cycleTime < duration + dt
        ) {
            this.endMaliciousSpike();
        }
    }

    startMaliciousSpike() {
        // A spike never interrupts an active traffic shift (and vice versa).
        if (this.trafficShiftActive) return;

        const world = this.world;
        this.maliciousSpikeActive = true;
        this.normalTrafficDist = { ...world.trafficDistribution };

        const maliciousPct =
            world.config.survival.maliciousSpike.maliciousPercent;
        const remaining = 1 - maliciousPct;

        // Guard against a distribution that's already 100% malicious —
        // otherwise every non-malicious share divides by zero and becomes
        // NaN/Infinity, corrupting the mix for the spike's duration
        // (「spike 防护」 regression).
        const otherTotal = 1 - this.normalTrafficDist.MALICIOUS;
        if (otherTotal <= 0) {
            world.trafficDistribution = { ...this.normalTrafficDist };
        } else {
            world.trafficDistribution = {
                STATIC: (this.normalTrafficDist.STATIC / otherTotal) * remaining,
                READ: (this.normalTrafficDist.READ / otherTotal) * remaining,
                WRITE: (this.normalTrafficDist.WRITE / otherTotal) * remaining,
                UPLOAD: (this.normalTrafficDist.UPLOAD / otherTotal) * remaining,
                SEARCH: (this.normalTrafficDist.SEARCH / otherTotal) * remaining,
                MALICIOUS: maliciousPct,
            };
        }

        world.hooks.onMaliciousSpikeStart?.();
    }

    endMaliciousSpike() {
        this.maliciousSpikeActive = false;

        if (this.normalTrafficDist) {
            this.world.trafficDistribution = { ...this.normalTrafficDist };
            this.normalTrafficDist = null;
        }

        this.world.hooks.onMaliciousSpikeEnd?.();
    }

    // ---- Traffic shift ------------------------------------------------

    _updateTrafficShift(dt) {
        const config = this.world.config.survival.trafficShift;
        if (!config?.enabled) return;

        this.trafficShiftTimer += dt;

        if (!this.trafficShiftActive && this.trafficShiftTimer >= config.interval) {
            this.startTrafficShift();
        }

        // The timer is reset to 0 when a shift actually activates (see
        // startTrafficShift), so here it measures time-since-active. The
        // historical 「事件计时器异常」 used the absolute interval+duration
        // threshold, so a shift delayed by an active malicious spike could
        // end on its very first active frame — running for ~0 seconds.
        if (this.trafficShiftActive && this.trafficShiftTimer >= config.duration) {
            this.endTrafficShift();
            this.trafficShiftTimer = 0; // reset for the next cycle
        }
    }

    startTrafficShift() {
        if (this.maliciousSpikeActive) return;

        const world = this.world;
        const shifts = world.config.survival.trafficShift.shifts;
        const shift = shifts[Math.floor(world.rng() * shifts.length)];

        this.currentShift = shift;
        this.trafficShiftActive = true;
        // Measure duration from actual activation, not from when the timer
        // first crossed `interval` (it may have kept growing while a
        // malicious spike blocked the start).
        this.trafficShiftTimer = 0;

        this.originalTrafficDist = { ...world.trafficDistribution };
        if (shift.distribution) {
            world.trafficDistribution = { ...shift.distribution };
        }

        // Shifts carry only { name, distribution } — the hook consumer must
        // present shift.name, never a (nonexistent) shift.type
        // (「流量切换崩溃」 regression).
        world.hooks.onTrafficShiftStart?.(shift);
    }

    endTrafficShift() {
        const shift = this.currentShift;
        this.trafficShiftActive = false;

        if (this.originalTrafficDist) {
            this.world.trafficDistribution = { ...this.originalTrafficDist };
            this.originalTrafficDist = null;
        }

        this.currentShift = null;
        this.world.hooks.onTrafficShiftEnd?.(shift);
    }

    // ---- Random events ------------------------------------------------

    _updateRandomEvents(dt) {
        const config = this.world.config.survival.randomEvents;
        if (!config?.enabled) return;

        this.randomEventTimer += dt;

        if (this.randomEventTimer >= config.checkInterval) {
            this.randomEventTimer = 0;
            // 30% chance to trigger an event at each check.
            if (this.world.rng() < 0.3) {
                this.triggerRandomEvent();
            }
        }

        if (this.activeEvent && this.world.time >= this.eventEndTime) {
            this.endRandomEvent();
        }
    }

    // durationSeconds defaults to the historical 30s. An explicit eventType
    // (and, for outages, outageServiceId) re-applies a known event — the
    // seam the web layer's pause/resume path historically needed; with
    // sim-clock timing a pause simply stops calling update, so the running
    // event keeps its target and remaining time by construction.
    triggerRandomEvent(eventType = null, durationSeconds = null, outageServiceId = null) {
        if (this.activeEvent) return;

        const world = this.world;
        const config = world.config.survival.randomEvents;
        if (!eventType) {
            eventType =
                config.types[Math.floor(world.rng() * config.types.length)];
        }
        if (!durationSeconds) durationSeconds = 30;

        this.activeEvent = eventType;
        this.eventEndTime = world.time + durationSeconds;
        this.eventDuration = durationSeconds;

        let outageTarget = null;

        switch (eventType) {
            case "COST_SPIKE":
                this.costMultiplier = 2.0;
                break;

            case "CAPACITY_DROP":
                world.services.forEach((s) => {
                    s.tempCapacityReduction = 0.5;
                });
                break;

            case "TRAFFIC_BURST":
                this.trafficBurstMultiplier = 3.0;
                break;

            case "SERVICE_OUTAGE": {
                // Reuse a previously-chosen service when re-applying a known
                // outage, otherwise pick a fresh random non-WAF target
                // (「outage 传送」 regression: the target must never re-roll
                // for the same outage).
                let target = outageServiceId
                    ? world.services.find((s) => s.id === outageServiceId)
                    : null;
                if (!target) {
                    const candidates = world.services.filter(
                        (s) => s.type !== "waf"
                    );
                    target =
                        candidates.length > 0
                            ? candidates[Math.floor(world.rng() * candidates.length)]
                            : null;
                }
                if (target) {
                    this.outageServiceId = target.id;
                    target.isDisabled = true;
                    outageTarget = target;
                }
                break;
            }
        }

        world.hooks.onEventStart?.(eventType, { service: outageTarget });
    }

    endRandomEvent() {
        if (!this.activeEvent) return;

        const world = this.world;
        const eventType = this.activeEvent;
        const reenabledServices = [];

        switch (eventType) {
            case "COST_SPIKE":
                this.costMultiplier = 1.0;
                break;

            case "CAPACITY_DROP":
                world.services.forEach((s) => {
                    s.tempCapacityReduction = 1.0;
                });
                break;

            case "TRAFFIC_BURST":
                this.trafficBurstMultiplier = 1.0;
                break;

            case "SERVICE_OUTAGE":
                world.services.forEach((s) => {
                    if (s.isDisabled) {
                        s.isDisabled = false;
                        reenabledServices.push(s);
                    }
                });
                this.outageServiceId = null;
                break;
        }

        this.activeEvent = null;
        world.hooks.onEventEnd?.(eventType, { services: reenabledServices });
    }

    // ---- RPS milestone acceleration -----------------------------------

    // Survival target RPS at the current sim time: logarithmic base growth
    // times the highest milestone multiplier reached. Crossing a milestone
    // announces it exactly once via the hook.
    targetRPS() {
        const world = this.world;
        const survival = world.config.survival;
        const t = world.time;

        const logGrowth = Math.log(1 + t / 20) * 2.2;
        const linearBoost = t * 0.008; // adds ~0.5 RPS per minute
        let targetRPS = survival.baseRPS + logGrowth + linearBoost;

        if (survival.rpsAcceleration) {
            const milestones = survival.rpsAcceleration.milestones;
            let multiplier = 1.0;

            for (let i = 0; i < milestones.length; i++) {
                if (t >= milestones[i].time) {
                    multiplier = milestones[i].multiplier;
                    if (this.currentMilestoneIndex < i + 1) {
                        this.currentMilestoneIndex = i + 1;
                        world.hooks.onRpsMilestone?.(milestones[i], i);
                    }
                }
            }

            this.rpsMultiplier = multiplier;
            targetRPS *= multiplier;
        }

        return targetRPS;
    }
}
