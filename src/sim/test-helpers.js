// Shared helpers for simulation-core tests (seam 1): build a headless
// world, wire a topology, inject traffic, step, and record every lifecycle
// hook the world emits.
import { SimWorld } from "./world.js";

// 50ms steps ≈ a 20fps frame — coarse enough to be fast, fine enough that
// every processing time in CONFIG (≥20ms) behaves like in the real loop.
export const STEP = 0.05;

export function recordingHooks() {
    const events = [];
    // Event-system records stamp the sim clock so tests can assert trigger
    // timing precisely; bind() is called by makeWorld once the world exists.
    let world = null;
    const t = () => (world ? world.time : null);
    return {
        events,
        bind(w) {
            world = w;
        },
        of(kind) {
            return events.filter((ev) => ev.e === kind);
        },
        onFinished: (req, via) =>
            events.push({ e: "finished", id: req.id, type: req.type, via, cached: req.cached }),
        onFailed: (req, reason) =>
            events.push({ e: "failed", id: req.id, type: req.type, reason }),
        onThrottled: (req) =>
            events.push({ e: "throttled", id: req.id, type: req.type }),
        onBlocked: (req) =>
            events.push({ e: "blocked", id: req.id, type: req.type }),
        onDiscarded: (req) =>
            events.push({ e: "discarded", id: req.id, type: req.type }),
        // ---- event system (M1-d) ----------------------------------------
        onMaliciousWarning: () =>
            events.push({ e: "maliciousWarning", t: t() }),
        onMaliciousSpikeStart: () =>
            events.push({ e: "spikeStart", t: t() }),
        onMaliciousSpikeEnd: () =>
            events.push({ e: "spikeEnd", t: t() }),
        onTrafficShiftStart: (shift) =>
            events.push({ e: "shiftStart", t: t(), name: shift.name }),
        onTrafficShiftEnd: (shift) =>
            events.push({ e: "shiftEnd", t: t(), name: shift?.name }),
        onEventStart: (type, detail) =>
            events.push({
                e: "eventStart",
                t: t(),
                type,
                serviceId: detail?.service?.id ?? null,
            }),
        onEventEnd: (type) =>
            events.push({ e: "eventEnd", t: t(), type }),
        onRpsMilestone: (milestone, index) =>
            events.push({
                e: "rpsMilestone",
                t: t(),
                time: milestone.time,
                multiplier: milestone.multiplier,
                index,
            }),
    };
}

// Default rng draws 0.999999: never a cache hit, never a load-failure roll
// (unless the fail chance saturates at 1) — the "nothing random happens"
// baseline. Pass createRngStub/createSeededRng to force specific branches.
export function makeWorld(opts = {}) {
    const hooks = recordingHooks();
    const world = new SimWorld({ rng: () => 0.999999, hooks, ...opts });
    hooks.bind(world);
    return { world, hooks, economy: world.economy, events: world.events };
}

export function wire(world, from, to) {
    return world.connect(
        from === "internet" ? "internet" : from.id,
        to === "internet" ? "internet" : to.id
    );
}

export function stepFor(world, seconds, dt = STEP) {
    // Half-step epsilon so float accumulation can't run one step long.
    for (let t = 0; t < seconds - dt / 2; t += dt) world.step(dt);
}

// Step until every request has reached a terminal state. Returns the
// simulated seconds it took; hitting maxSeconds with live requests left
// means something is stuck (see the dead-loop regression test).
export function runUntilDrained(world, { maxSeconds = 60, dt = STEP } = {}) {
    let t = 0;
    while (world.requests.length > 0 && t < maxSeconds) {
        world.step(dt);
        t += dt;
    }
    return t;
}

// A full survival-style run shared by the deterministic-replay and
// particle-cap parity tests: mixed traffic through a realistic topology,
// long enough (110 sim-seconds by default) to cross a traffic shift (40s),
// a malicious spike (blocked by the shift at 45s, lands at 90s),
// random-event checks (every 30s) and the first RPS milestone (60s).
export function runSurvivalScenario(world, { seconds = 110 } = {}) {
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

    const steps = Math.round(seconds / STEP);
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
}

export function terminalTotal(world) {
    const s = world.stats;
    return (
        s.completed +
        s.failed +
        s.throttled +
        s.maliciousBlocked +
        s.maliciousPassed +
        s.discarded
    );
}
