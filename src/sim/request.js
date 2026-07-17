// Simulation-core request (CONTEXT.md: 请求). Pure logic — no DOM, no
// Three.js. The web entity (src/entities/Request.js) subclasses this and
// adds the mesh; headless tests use it directly.
//
// A request's life: spawned at the internet node, routed to an entry
// service (SimWorld.routeRequestToEntry), then hops service to service via
// flyTo until a terminal transition on the world removes it (finish / fail
// / throttle / block). A hop takes 0.5 simulated seconds (progress += dt*2),
// which is behavior, not cosmetics: in-flight requests hold an
// incomingCount slot on their target, and that drives SQS backpressure and
// the compute pull pipeline.
export class SimRequest {
    constructor(world, type) {
        this.world = world;
        this.id = world.nextRequestId();
        this.type = type;
        this.typeConfig = world.config.trafficTypes[type];
        this.value = this.typeConfig.reward;
        this.cached = false;

        this.target = null;
        this.progress = 0;
        this.isMoving = false;
    }

    get isCacheable() {
        return this.typeConfig.cacheable && !this.cached;
    }

    get cacheHitRate() {
        return this.typeConfig.cacheHitRate;
    }

    get destination() {
        return this.typeConfig.destination;
    }

    get processingWeight() {
        return this.typeConfig.processingWeight;
    }

    flyTo(service) {
        this.target = service;
        this.progress = 0;
        this.isMoving = true;

        if (this.target && typeof this.target.incomingCount === "number") {
            this.target.incomingCount++;
        }
    }

    update(dt) {
        if (this.isMoving && this.target) {
            this.progress += dt * 2;
            if (this.progress >= 1) {
                this.progress = 1;
                this.isMoving = false;

                if (this.target && typeof this.target.incomingCount === "number") {
                    this.target.incomingCount = Math.max(0, this.target.incomingCount - 1);
                }

                // Use service-specific max queue size
                const maxQueue = this.target.config.maxQueueSize || 20;
                if (this.target.queue.length < maxQueue) {
                    this.target.queue.push(this);
                } else {
                    this.world.failRequest(this, "queue-overflow");
                }
            }
        }
    }
}
