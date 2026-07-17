// Simulation core world — seam 1 (docs/specs/2026-07-17-mobile-web-v1.md,
// Testing Decisions). Headless by construction: no DOM, no Three.js, all
// randomness through the injected rng. Build a world, add services, connect
// them, inject traffic, step(dt), then assert terminal states.
//
// What lives here (M1-b/M1-c): traffic spawning, entry selection, per-hop
// routing (in SimService), the request lifecycle terminals (finish / fail /
// throttle / block / remove), and — via `economy` — every settlement those
// terminals trigger: income, scoring, reputation, maintenance fees, repair
// and serverless billing. Sounds and visuals are the caller's business: the
// web layer subscribes via `hooks` for presentation only.
import { CONFIG, TRAFFIC_TYPES } from "../config.js";
import { SimEconomy } from "./economy.js";
import { SimRequest, releaseInFlightSlot } from "./request.js";
import { SimService } from "./service.js";

export class SimWorld {
    constructor({
        config = CONFIG,
        trafficTypes = TRAFFIC_TYPES,
        rng,
        hooks = {},
        trafficDistribution = null,
        requestFactory = null,
    } = {}) {
        // No default on purpose: the sim core must never name a platform
        // RNG itself (CONTEXT.md 仿真核心). The web layer injects
        // Math.random; tests inject seeded/scripted rngs.
        if (typeof rng !== "function") {
            throw new TypeError("SimWorld requires an injected rng () => [0,1)");
        }
        this.config = config;
        this.trafficTypes = trafficTypes;
        this.rng = rng;
        this.hooks = hooks;
        // The web layer swaps this for a factory producing renderable
        // requests; the sim only relies on the SimRequest contract.
        this.requestFactory =
            requestFactory || ((world, type) => new SimRequest(world, type));

        this.services = [];
        this.requests = [];
        this.internet = { id: "internet", type: "internet", connections: [] };
        // Simulated game time in seconds. step() advances it; the upkeep
        // time escalation reads it. The web layer keeps it in sync with its
        // own frame clock via the STATE.elapsedGameTime alias.
        this.time = 0;
        this.economy = new SimEconomy(this);
        this.trafficDistribution =
            trafficDistribution || { ...config.survival.trafficDistribution };

        // Round-robin counters for entry-point load splitting across
        // multiple services of the same type (e.g. two WAFs on the Internet).
        // Keyed by service type ("waf", "cdn", "apigw", "any").
        this.entryRRIndex = {};

        // Terminal-state tally. Every spawned request ends in exactly one of
        // the five terminal buckets (or is discarded by removeRequest when
        // the player deletes its service) — the conservation invariant the
        // characterization tests pin down.
        this.stats = {
            spawned: 0,
            completed: 0,
            failed: 0,
            throttled: 0,
            maliciousBlocked: 0,
            maliciousPassed: 0,
            discarded: 0,
        };

        this._requestSeq = 0;
        this._serviceSeq = 0;
    }

    nextRequestId() {
        return "req_" + ++this._requestSeq;
    }

    nextServiceId() {
        return "svc_" + ++this._serviceSeq;
    }

    // Restoring a save overwrites generated ids with the saved ones. Any
    // sequential-format id ("svc_<n>") must advance the sequence past n, or
    // the next placed service could mint a duplicate id — duplicate ids
    // corrupt connection lookups and deletion. Pre-refactor random ids
    // don't match the pattern and can't collide with the counter format.
    claimServiceId(id) {
        const m = /^svc_(\d+)$/.exec(id);
        if (m) this._serviceSeq = Math.max(this._serviceSeq, Number(m[1]));
    }

    getService(id) {
        return this.services.find((s) => s.id === id);
    }

    // Headless world construction. The topology validity matrix stays in the
    // UI layer (game.js createConnection) for now; the sim trusts its caller.
    addService(type) {
        const service = new SimService(this, type);
        this.services.push(service);
        return service;
    }

    connect(fromId, toId) {
        const from =
            fromId === "internet" ? this.internet : this.getService(fromId);
        const to = toId === "internet" ? this.internet : this.getService(toId);
        if (!from || !to || from.connections.includes(toId)) return false;
        from.connections.push(toId);
        return true;
    }

    getTrafficType() {
        const dist = this.trafficDistribution;
        const types = Object.keys(dist);
        const total = types.reduce((sum, type) => sum + (dist[type] || 0), 0);
        // All types at 0% means "no traffic", not "default to STATIC" (#174).
        if (total === 0) return null;

        const r = this.rng() * total;
        let cumulative = 0;

        for (const type of types) {
            cumulative += dist[type] || 0;
            if (r < cumulative) {
                return this.trafficTypes[type] || type;
            }
        }

        return this.trafficTypes.STATIC;
    }

    pickEntryNode(entryNodes, type) {
        // Filter for live (non-disabled) nodes of the requested type.
        // Type "any" means "any live entry node" (last-resort path).
        const candidates = entryNodes.filter((s) => {
            if (!s || s.isDisabled) return false;
            return type === "any" ? true : s.type === type;
        });
        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];

        // Round robin: each subsequent call rotates to the next candidate,
        // splitting load evenly across identical entry points.
        const idx = (this.entryRRIndex[type] || 0) % candidates.length;
        this.entryRRIndex[type] = idx + 1;
        return candidates[idx];
    }

    // Shared entry routing for spawned traffic (regular spawns AND sandbox bursts).
    // Round-robin aware so multiple firewalls / CDNs / gateways share the load.
    routeRequestToEntry(req, type) {
        const conns = this.internet.connections;
        if (conns.length === 0) {
            this.failRequest(req, "no-entry");
            return;
        }
        const entryNodes = conns.map((id) => this.getService(id));

        let target;

        // 1. Prefer CDN for STATIC traffic
        if (type === "STATIC") {
            target = this.pickEntryNode(entryNodes, "cdn");
        }

        // 2. Fallback to WAF (Security Best Practice)
        if (!target) {
            target = this.pickEntryNode(entryNodes, "waf");
        }

        // 3. Fallback to API Gateway (Rate Limiting)
        if (!target) {
            target = this.pickEntryNode(entryNodes, "apigw");
        }

        // 4. Last Resort: any live entry point (also round-robin)
        if (!target) {
            target = this.pickEntryNode(entryNodes, "any");
        }

        if (target) req.flyTo(target);
        else this.failRequest(req, "no-entry");
    }

    // Inject traffic. With no argument, draws a type from the current
    // traffic distribution (returns null when the mix is all-zero, #174);
    // with an explicit type, spawns exactly that (sandbox bursts).
    spawnRequest(type = undefined) {
        if (type === undefined) {
            type = this.getTrafficType();
            if (type === null) return null;
        }
        const req = this.requestFactory(this, type);
        this.stats.spawned++;
        this.requests.push(req);
        this.routeRequestToEntry(req, type);
        return req;
    }

    // Advance the simulation. Mirrors the frame order of the web game loop:
    // the clock advances first, then services route/process, then in-flight
    // requests move.
    step(dt) {
        this.time += dt;
        this.services.forEach((s) => s.update(dt));
        this.requests.forEach((r) => r.update(dt));
    }

    // Serverless per-invocation billing point (called by SimService at every
    // routing/terminal decision on a serverless node, including failures).
    chargeServerless(service) {
        this.economy.chargeServerless(service);
        this.hooks.onServerlessCharge?.(service);
    }

    // ---- Request lifecycle terminals ----------------------------------
    // Each removes the request from the simulation immediately and notifies
    // the corresponding hook exactly once. Death animations (the 500ms red
    // flash in the web layer) are presentation, not simulation.

    finishRequest(req, viaServiceType) {
        this.stats.completed++;
        this.economy.settle("COMPLETED", req);
        this._removeFromSim(req);
        this.hooks.onFinished?.(req, viaServiceType);
    }

    failRequest(req, reason = null) {
        if (req.type === this.trafficTypes.MALICIOUS) {
            this.stats.maliciousPassed++;
            this.economy.settle("MALICIOUS_PASSED", req);
        } else {
            this.stats.failed++;
            this.economy.settle("FAILED", req);
        }
        this._removeFromSim(req);
        this.hooks.onFailed?.(req, reason);
    }

    throttleRequest(req) {
        this.stats.throttled++;
        this.economy.settle("THROTTLED", req);
        this._removeFromSim(req);
        this.hooks.onThrottled?.(req);
    }

    // WAF interception of MALICIOUS traffic.
    blockRequest(req) {
        this.stats.maliciousBlocked++;
        this.economy.settle("MALICIOUS_BLOCKED", req);
        this._removeFromSim(req);
        this.hooks.onBlocked?.(req);
    }

    // Non-scoring removal: the player deleted a service and its traffic is
    // discarded cleanly (restructuring, not dropping production traffic).
    removeRequest(req) {
        this.stats.discarded++;
        this._removeFromSim(req);
        this.hooks.onDiscarded?.(req);
    }

    _removeFromSim(req) {
        if (req.isMoving) releaseInFlightSlot(req);
        req.isMoving = false;
        this.requests = this.requests.filter((r) => r !== req);
    }
}
