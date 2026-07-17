// Simulation-core service (CONTEXT.md: 服务). Pure logic — no DOM, no
// Three.js, no direct Math.random (randomness comes from world.rng). The
// web entity (src/entities/Service.js) subclasses this and adds meshes,
// sounds and economy; headless tests use it directly.
//
// update(dt) owns the per-hop routing pipeline: API-gateway rate window,
// compute/serverless pull from upstream SQS, queue admission (WAF blocks
// malicious traffic here), and the processing loop that decides each
// finished job's next hop or terminal state. Health degradation, upkeep
// and per-request billing stay in outer layers — the sim only reads
// `health` and emits hooks at the billing points.

/**
 * Calculates the percentage if failure based on the load of the node.
 * @param {number} load fractions of 1 (0 to 1) of how loaded the node is
 * @returns {number} chance of failure (0 to 1)
 */
export function calculateFailChanceBasedOnLoad(load) {
    if (load <= 0.5) return 0;
    return 2 * (load - 0.5);
}

export class SimService {
    constructor(world, type) {
        this.world = world;
        this.id = world.nextServiceId();
        this.type = type;
        this.config = world.config.services[type];
        this.queue = [];
        this.processing = [];
        this.connections = [];
        this.incomingCount = 0;
        this.tier = 1;
        this.rrIndex = 0;

        // Service health for degradation mechanic. Decay/repair live in the
        // web layer until the event system migrates (M1-d); the sim reads
        // health for effective capacity and failure chance.
        this.health = 100;
    }

    get totalLoad() {
        return (
            (this.processing.length + this.queue.length) / (this.config.capacity * 2)
        );
    }

    getEffectiveCapacity() {
        // Reduce capacity when health is low
        let capacity = this.config.capacity;

        // Apply health-based reduction
        const criticalHealth =
            this.world.config.survival.degradation?.criticalHealth || 30;
        if (this.health < criticalHealth) {
            // Linear reduction from critical to 0 health: 100% -> 30% capacity
            const healthRatio = this.health / criticalHealth;
            capacity = Math.max(1, Math.floor(capacity * (0.3 + 0.7 * healthRatio)));
        }

        // Apply temporary capacity reduction from random events
        if (this.tempCapacityReduction && this.tempCapacityReduction < 1) {
            capacity = Math.max(1, Math.floor(capacity * this.tempCapacityReduction));
        }

        // Check if service is disabled
        if (this.isDisabled) {
            return 0;
        }

        return capacity;
    }

    processQueue() {
        const effectiveCapacity = this.getEffectiveCapacity();
        while (
            this.processing.length < effectiveCapacity &&
            this.queue.length > 0
        ) {
            const req = this.queue.shift();

            if (this.type === "waf" && req.type === this.world.trafficTypes.MALICIOUS) {
                // Must go through blockRequest (not a raw drop) — otherwise the
                // blocked request stays in world.requests forever and is ticked
                // every frame. This fires on every WAF block (a large fraction of
                // all traffic), so dropping it raw leaked the request array
                // unbounded over a session.
                this.world.blockRequest(req);
                continue;
            }

            this.processing.push({ req: req, timer: 0 });
        }
    }

    findConnectedService(serviceType) {
        // Skip disabled services (e.g. during a SERVICE_OUTAGE event) so routing
        // falls through to a healthy alternative instead of stalling traffic on a
        // node with 0 effective capacity — otherwise the redundancy the player
        // built (the whole point of the High Availability level) does nothing.
        return this.world.services.find(
            (s) => this.connections.includes(s.id) && s.type === serviceType && !s.isDisabled
        );
    }

    forwardToDestination(req) {
        const destType = req.destination;
        const target = this.findConnectedService(destType);
        if (target) {
            req.flyTo(target);
            return true;
        }
        return false;
    }

    popRequest() {
        // Try to take from processing list first (these are "ready" or "in-flight" but held back)
        if (this.processing.length > 0) {
            // Taking from the start (index 0) which should be the oldest if we push to end?
            // processing array is likely small for SQS.
            // NOTE: processing contains {req, timer} objects
            const job = this.processing.shift();
            return job.req;
        }

        // If nothing in processing, check the queue
        if (this.queue.length > 0) {
            return this.queue.shift();
        }

        return null;
    }

    update(dt) {
        // API Gateway rate counter reset
        if (this.type === "apigw") {
            this.rateTimer = (this.rateTimer || 0) + dt;
            if (this.rateTimer >= 1.0) {
                this.rateCounter = 0;
                this.rateTimer -= 1.0;
            }
        }

        // COMPUTE / SERVERLESS PULL LOGIC
        if (this.type === "compute" || this.type === "serverless") {
            // Keep the local pipeline full. The upstream SQS does the long-term
            // buffering, but Compute must pull aggressively enough to saturate its
            // own processing slots.
            //
            // The previous logic pulled at most ONE request per frame and only when
            // (queue + inFlight) <= 1. Because a request spends ~0.5s in flight from
            // SQS to Compute, that capped the SQS→Compute path at ~4 req/s no matter
            // how upgraded the Compute was — making the Queue topology strictly worse
            // than a direct ALB link and soft-locking Campaign Level 5 (#170) and
            // degrading late-game Queue setups (#166).
            //
            // New logic: pull until processing + queue + inFlight covers effective
            // capacity plus a small buffer, so the pipeline never starves while
            // requests are in flight.
            const capacity = this.getEffectiveCapacity();
            const pipelineTarget = capacity + 2;
            let freeSlots = pipelineTarget - (this.processing.length + this.queue.length + this.incomingCount);

            if (freeSlots > 0) {
                // Find upstream SQS services
                const upstreamSQS = this.world.services.filter(s =>
                    s.type === 'sqs' &&
                    s.connections.includes(this.id) &&
                    !s.isDisabled
                );

                if (upstreamSQS.length > 0) {
                    // Round robin pull across upstream queues until slots are filled
                    // or every queue is empty this frame.
                    if (typeof this.upstreamRR === 'undefined') this.upstreamRR = 0;

                    let emptyStreak = 0;
                    while (freeSlots > 0 && emptyStreak < upstreamSQS.length) {
                        const idx = this.upstreamRR % upstreamSQS.length;
                        const sqs = upstreamSQS[idx];
                        this.upstreamRR = (idx + 1) % upstreamSQS.length;

                        const req = sqs.popRequest();
                        if (req) {
                            req.flyTo(this);
                            freeSlots--;
                            emptyStreak = 0;
                        } else {
                            emptyStreak++;
                        }
                    }
                }
            }
        }

        this.processQueue();

        for (let i = this.processing.length - 1; i >= 0; i--) {
            let job = this.processing[i];

            const processingTime =
                this.type === "compute" || this.type === "serverless"
                    ? this.config.processingTime * job.req.processingWeight
                    : this.config.processingTime;

            job.timer += dt * 1000;

            if (job.timer >= processingTime) {
                this.processing.splice(i, 1);

                const failChance = calculateFailChanceBasedOnLoad(this.totalLoad);
                // Increase fail chance when health is low
                const healthPenalty =
                    this.health < (this.world.config.survival.degradation?.criticalHealth || 30)
                        ? (1 - this.health / 100) * 0.5
                        : 0;
                const totalFailChance = Math.min(1, failChance + healthPenalty);
                if (this.world.rng() < totalFailChance) {
                    // Serverless pays per invocation even when the function errors out
                    if (this.type === "serverless") {
                        this.world.hooks.onServerlessCharge?.(this);
                    }
                    this.world.failRequest(job.req, "processing-failure");
                    continue;
                }

                if (this.type === "db") {
                    if (job.req.destination === "db") {
                        this.world.finishRequest(job.req, this.type);
                    } else {
                        this.world.failRequest(job.req, "wrong-destination");
                    }
                    continue;
                }

                if (this.type === "nosql") {
                    // NoSQL handles READ and WRITE, but NOT SEARCH
                    if (job.req.type === "SEARCH") {
                        this.world.failRequest(job.req, "wrong-destination");
                    } else if (job.req.destination === "db") {
                        this.world.finishRequest(job.req, this.type);
                    } else {
                        this.world.failRequest(job.req, "wrong-destination");
                    }
                    continue;
                }

                if (this.type === "search") {
                    if (job.req.type === "SEARCH") {
                        this.world.finishRequest(job.req, this.type);
                    } else {
                        this.world.failRequest(job.req, "wrong-destination");
                    }
                    continue;
                }

                if (this.type === "replica") {
                    const hasMaster = this.connections.some(id => {
                        const s = this.world.services.find(svc => svc.id === id);
                        return s && (s.type === "db" || s.type === "nosql");
                    });
                    if (!hasMaster) {
                        this.world.failRequest(job.req, "no-route");
                        continue;
                    }
                    if (job.req.type === "READ" && job.req.destination === "db") {
                        this.world.finishRequest(job.req, this.type);
                    } else {
                        this.world.failRequest(job.req, "wrong-destination");
                    }
                    continue;
                }

                if (this.type === "s3") {
                    if (job.req.destination === "s3" || job.req.destination === "cdn") {
                        this.world.finishRequest(job.req, this.type);
                    } else {
                        this.world.failRequest(job.req, "wrong-destination");
                    }
                    continue;
                }

                if (this.type === "cache") {
                    if (job.req.isCacheable) {
                        const hitRate = job.req.cacheHitRate;

                        if (this.world.rng() < hitRate) {
                            job.req.cached = true;
                            this.world.hooks.onCacheHit?.(this, job.req);
                            this.world.finishRequest(job.req, this.type);
                            continue;
                        }
                    }

                    const destType = job.req.destination;

                    // Cache miss routing: prefer specialized services
                    if (destType === "db") {
                        if (job.req.type === "SEARCH") {
                            const searchTarget = this.findConnectedService("search");
                            if (searchTarget) { job.req.flyTo(searchTarget); continue; }
                        }
                        if (job.req.type === "READ") {
                            const replicaTarget = this.findConnectedService("replica");
                            if (replicaTarget) { job.req.flyTo(replicaTarget); continue; }
                        }
                        if (job.req.type !== "SEARCH") {
                            const nosqlTarget = this.findConnectedService("nosql");
                            if (nosqlTarget) { job.req.flyTo(nosqlTarget); continue; }
                        }
                        const sqlTarget = this.findConnectedService("db");
                        if (sqlTarget) { job.req.flyTo(sqlTarget); continue; }
                        this.world.failRequest(job.req, "no-route");
                    } else {
                        // Storage-family destinations are interchangeable on a miss (#88):
                        // STATIC's destination is "cdn" but a Cache wired to S3 should still
                        // deliver it — both are static-content origins.
                        let target = this.findConnectedService(destType);
                        if (!target && (destType === "cdn" || destType === "s3")) {
                            target = this.findConnectedService(destType === "cdn" ? "s3" : "cdn");
                        }
                        if (target) {
                            job.req.flyTo(target);
                        } else {
                            this.world.failRequest(job.req, "no-route");
                        }
                    }
                    continue;
                }

                // CDN processing logic - High cache hit rate for static content
                if (this.type === "cdn") {
                    if (job.req.type === "STATIC") {
                        const hitRate = this.config.cacheHitRate || 0.95;

                        // CDN Cache Hit
                        if (this.world.rng() < hitRate) {
                            job.req.cached = true;
                            this.world.hooks.onCacheHit?.(this, job.req);
                            this.world.finishRequest(job.req, this.type);
                            continue;
                        }
                    }

                    // Cache Miss - Forward to Origin (S3 or whatever is connected)
                    // We look for any connected service that isn't Internet
                    const connectedServices = this.connections
                        .map((id) => this.world.services.find((s) => s.id === id))
                        .filter((s) => s && s.type !== "internet" && !s.isDisabled);

                    if (connectedServices.length > 0) {
                        // Simple round robin or just pick first
                        const target = connectedServices[0];
                        job.req.flyTo(target);
                    } else {
                        // Configuring Miss but no origin = Fail
                        this.world.failRequest(job.req, "no-route");
                    }
                    continue;
                }

                // SQS processing logic
                if (this.type === "sqs") {
                    // SQS just forwards requests with backpressure check
                    // MODIFIED: Filter out compute nodes, they will PULL from us instead
                    const downstreamTypes = ["alb"];
                    // We intentionally excluded "compute" from the automatic push list.
                    // Compute nodes must actively pull from SQS.

                    const candidates = this.connections
                        .map((id) => this.world.services.find((s) => s.id === id))
                        .filter((s) => s && downstreamTypes.includes(s.type) && !s.isDisabled);

                    // If no candidates (e.g. only connected to compute), we just wait.
                    // The request remains in 'processing' (it was spliced out, so we need to put it back if we don't send it)
                    if (candidates.length === 0) {
                        // Put it back so it's not lost, and can be popped by compute
                        this.processing.splice(i, 0, job);
                        continue;
                    }

                    // Round-robin with backpressure check
                    let sent = false;
                    for (let attempt = 0; attempt < candidates.length; attempt++) {
                        const target = candidates[this.rrIndex % candidates.length];
                        this.rrIndex++;

                        const targetMaxQueue = target.config.maxQueueSize || 20;
                        if (target.queue.length + target.incomingCount < targetMaxQueue) {
                            job.req.flyTo(target);
                            sent = true;
                            break;
                        }
                    }

                    if (!sent) {
                        // Downstream busy - keep in processing to retry next frame
                        // Since it was removed at the start of the block, we put it back
                        this.processing.splice(i, 0, job);
                        break;
                    }
                    continue;
                }

                // API Gateway processing logic - rate limiting
                if (this.type === "apigw") {
                    this.rateCounter = (this.rateCounter || 0) + 1;
                    const rateLimit = this.config.rateLimit || 20;

                    if (this.rateCounter > rateLimit) {
                        // Rate limited - soft fail
                        this.world.throttleRequest(job.req);
                        continue;
                    }

                    // Forward to downstream (ALB, SQS, Compute)
                    const candidates = this.connections
                        .map((id) => this.world.services.find((s) => s.id === id))
                        .filter((s) => s && !s.isDisabled);

                    if (candidates.length > 0) {
                        const target = candidates[this.rrIndex % candidates.length];
                        this.rrIndex++;
                        job.req.flyTo(target);
                    } else {
                        this.world.failRequest(job.req, "no-route");
                    }
                    continue;
                }

                if (this.type === "compute" || this.type === "serverless") {
                    // Per-request cost for serverless (AWS Lambda style - charged per invocation,
                    // including failed ones since you still pay for execution time).
                    // Billing itself lives in the web layer until economy migrates (M1-c).
                    const chargePerRequest = () => {
                        if (this.type !== "serverless") return;
                        this.world.hooks.onServerlessCharge?.(this);
                    };

                    const destType = job.req.destination;

                    if (destType === "blocked") {
                        chargePerRequest();
                        this.world.failRequest(job.req, "malicious-destination");
                        continue;
                    }

                    if (job.req.isCacheable) {
                        // Prefer specialized services over Cache when they're a better fit (#167):
                        // - SEARCH cache hit rate is only 15%, so routing through Cache is mostly
                        //   wasted latency. If a Search Engine is connected, use it directly.
                        // - READ hit rate is 40%, but if Cache is heavily loaded, its queue delay
                        //   outweighs the savings — prefer Read Replica when both are connected
                        //   and Cache is >60% loaded.
                        if (job.req.type === "SEARCH") {
                            const searchDirect = this.findConnectedService("search");
                            if (searchDirect) {
                                chargePerRequest();
                                job.req.flyTo(searchDirect);
                                continue;
                            }
                        }
                        const cacheTarget = this.findConnectedService("cache");
                        if (job.req.type === "READ" && cacheTarget && cacheTarget.totalLoad > 0.6) {
                            const replicaDirect = this.findConnectedService("replica");
                            if (replicaDirect) {
                                chargePerRequest();
                                job.req.flyTo(replicaDirect);
                                continue;
                            }
                        }
                        // Only route through Cache if a miss can still reach its destination
                        // from there (#88). A Cache wired only to the DB must not swallow
                        // STATIC traffic whose destination is Storage — those requests
                        // should use Compute's direct S3 link instead.
                        if (cacheTarget) {
                            const dest = job.req.destination;
                            const cacheCanDeliver =
                                dest === "db"
                                    ? true // cache-miss cascade handles search/replica/nosql/db
                                    : !!(cacheTarget.findConnectedService("s3") ||
                                        cacheTarget.findConnectedService("cdn"));
                            if (cacheCanDeliver) {
                                chargePerRequest();
                                job.req.flyTo(cacheTarget);
                                continue;
                            }
                        }
                    }

                    // Routing: prefer specialized services, fallback to general
                    if (destType === "db") {
                        if (job.req.type === "SEARCH") {
                            const searchTarget = this.findConnectedService("search");
                            if (searchTarget) { chargePerRequest(); job.req.flyTo(searchTarget); continue; }
                            const sqlTarget = this.findConnectedService("db");
                            if (sqlTarget) { chargePerRequest(); job.req.flyTo(sqlTarget); continue; }
                        } else if (job.req.type === "READ") {
                            const replicaTarget = this.findConnectedService("replica");
                            if (replicaTarget) { chargePerRequest(); job.req.flyTo(replicaTarget); continue; }
                            const nosqlTarget = this.findConnectedService("nosql");
                            if (nosqlTarget) { chargePerRequest(); job.req.flyTo(nosqlTarget); continue; }
                            const sqlTarget = this.findConnectedService("db");
                            if (sqlTarget) { chargePerRequest(); job.req.flyTo(sqlTarget); continue; }
                        } else {
                            const nosqlTarget = this.findConnectedService("nosql");
                            if (nosqlTarget) { chargePerRequest(); job.req.flyTo(nosqlTarget); continue; }
                            const sqlTarget = this.findConnectedService("db");
                            if (sqlTarget) { chargePerRequest(); job.req.flyTo(sqlTarget); continue; }
                        }
                        chargePerRequest();
                        this.world.failRequest(job.req, "no-route");
                        continue;
                    }

                    // Storage-family destinations are interchangeable (#88): STATIC's
                    // destination is "cdn" but a Compute wired directly to S3 must still
                    // deliver it — both are static-content origins.
                    let directTarget = this.findConnectedService(destType);
                    if (!directTarget && (destType === "cdn" || destType === "s3")) {
                        directTarget = this.findConnectedService(destType === "cdn" ? "s3" : "cdn");
                    }
                    if (directTarget) {
                        chargePerRequest();
                        job.req.flyTo(directTarget);
                    } else {
                        chargePerRequest();
                        this.world.failRequest(job.req, "no-route");
                    }
                } else {
                    const candidates = this.connections
                        .map((id) => this.world.services.find((s) => s.id === id))
                        .filter((s) => s !== undefined && !s.isDisabled); // Skip offline nodes

                    if (candidates.length > 0) {
                        const target = candidates[this.rrIndex % candidates.length];
                        this.rrIndex++;
                        job.req.flyTo(target);
                    } else {
                        this.world.failRequest(job.req, "no-route");
                    }
                }
            }
        }
    }
}
