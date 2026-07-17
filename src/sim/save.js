// Simulation-core save serialization (CONTEXT.md: 仿真核心 — 存档序列化).
// Owns the save schema: what a save contains, how legacy saves migrate, and
// how a world is rebuilt from one. Storage itself (localStorage, file
// download) is the platform layer's job — this module never touches it; the
// key below is exported so the web layer names the same slot it always has.
//
// Format compatibility is a hard contract (spec 存档兼容): the payload shape
// matches what the pre-refactor web layer wrote — same key, same version tag,
// same field names — so saves cross the refactor in both directions.
import { SimService } from "./service.js";
import { defaultFinances } from "./economy.js";

export const SAVE_KEY = "serverSurvivalSave";
export const SAVE_VERSION = "2.0";

// v1-era saves used WEB/API/FRAUD traffic types and web/api/fraudBlocked
// score buckets. Mapping preserved verbatim from the pre-refactor loader.
export function migrateLegacySave(saveData) {
    if (saveData.trafficDistribution) {
        const oldDist = saveData.trafficDistribution;
        if ("WEB" in oldDist || "API" in oldDist || "FRAUD" in oldDist) {
            saveData.trafficDistribution = {
                STATIC: oldDist.WEB || 0,
                READ: (oldDist.API || 0) * 0.5,
                WRITE: (oldDist.API || 0) * 0.3,
                UPLOAD: 0.05,
                SEARCH: (oldDist.API || 0) * 0.2,
                MALICIOUS: oldDist.FRAUD || 0,
            };
        }
    }

    if (saveData.score) {
        const oldScore = saveData.score;
        if ("web" in oldScore || "api" in oldScore || "fraudBlocked" in oldScore) {
            saveData.score = {
                total: oldScore.total || 0,
                storage: oldScore.web || 0,
                database: oldScore.api || 0,
                maliciousBlocked: oldScore.fraudBlocked || 0,
            };
        }
    }

    if ("fraudSpikeTimer" in saveData) {
        saveData.maliciousSpikeTimer = saveData.fraudSpikeTimer;
        delete saveData.fraudSpikeTimer;
    }
    if ("fraudSpikeActive" in saveData) {
        saveData.maliciousSpikeActive = saveData.fraudSpikeActive;
        delete saveData.fraudSpikeActive;
    }

    return saveData;
}

// Migrate in place when the save predates the version tag (or is v1.0).
export function normalizeSave(saveData) {
    if (!saveData.version || saveData.version === "1.0") {
        return migrateLegacySave(saveData);
    }
    return saveData;
}

function serializeService(service) {
    const pos = service.position;
    return {
        id: service.id,
        type: service.type,
        position: pos ? [pos.x, pos.y, pos.z] : [0, 0, 0],
        connections: [...service.connections],
        tier: service.tier,
        cacheHitRate: service.config.cacheHitRate || null,
    };
}

// The full edge list, internet entries first — the same information the web
// layer's chronological connection list carried, grouped per node so each
// node's round-robin order is preserved across a round trip.
function serializeConnections(world) {
    return [
        ...world.internet.connections.map((to) => ({ from: "internet", to })),
        ...world.services.flatMap((s) =>
            s.connections.map((to) => ({ from: s.id, to }))
        ),
    ];
}

// Build the save payload. `state` is the web layer's state bag, spread
// through untouched exactly like the pre-refactor `...STATE` (UI fields,
// intervention state, campaign state…); every sim-owned field is then
// written explicitly so headless callers don't need a bag at all.
export function buildSaveData({ timestamp, state = {}, world }) {
    const economy = world.economy;
    return {
        timestamp,
        version: SAVE_VERSION,
        ...state,
        money: economy.money,
        reputation: economy.reputation,
        score: { ...economy.score },
        failures: { ...economy.failures },
        finances: economy.finances,
        elapsedGameTime: world.time,
        trafficDistribution: { ...world.trafficDistribution },
        services: world.services.map(serializeService),
        connections: serializeConnections(world),
        requests: [],
        internetConnections: [...world.internet.connections],
    };
}

// Reapply a saved service record onto a freshly constructed service: saved
// id (advancing the world's id sequence past it) and tier configuration.
// Verbatim tier semantics from the pre-refactor restore path.
export function applySavedService(service, serviceData) {
    service.id = serviceData.id;
    service.world.claimServiceId(serviceData.id);

    if (serviceData.tier && serviceData.tier > 1) {
        const tiers = service.world.config.services[serviceData.type]?.tiers;
        if (tiers) {
            service.tier = serviceData.tier;
            const tierData = tiers[service.tier - 1];
            if (tierData) {
                service.config = { ...service.config, capacity: tierData.capacity };
                if (tierData.cacheHitRate) {
                    service.config = {
                        ...service.config,
                        cacheHitRate: tierData.cacheHitRate,
                    };
                }
                if (tierData.rateLimit) {
                    service.config = {
                        ...service.config,
                        rateLimit: tierData.rateLimit,
                    };
                }
            }
        }
    }
}

// Restore the economy books. Finances merge over zeroed defaults so saves
// from before (or between) finance-tracking versions load with 0s, never
// undefined — the 「存档丢财务状态」 regression. `failures` is deliberately
// not restored: the pre-refactor loader never did, and behavior parity wins
// over tidiness until that's revisited on its own.
export function restoreEconomy(economy, saveData) {
    economy.money = saveData.money || 0;
    economy.reputation = saveData.reputation || 100;
    economy.score = { ...saveData.score };

    const defaults = defaultFinances();
    economy.finances = saveData.finances
        ? {
              income: { ...defaults.income, ...saveData.finances.income },
              expenses: { ...defaults.expenses, ...saveData.finances.expenses },
          }
        : defaults;
}

// Rebuild services and connections. The web layer injects `createService`
// (to build renderable services), `onServiceRestored` (meshes, sounds) and
// `connect` (topology-validated, mesh-drawing connection routine); headless
// callers get pure sim services and world.connect.
export function restoreTopology(world, saveData, options = {}) {
    const createService =
        options.createService || ((data) => new SimService(world, data.type));
    const connect = options.connect || ((from, to) => world.connect(from, to));

    for (const serviceData of saveData.services || []) {
        const service = createService(serviceData);
        applySavedService(service, serviceData);
        world.services.push(service);
        options.onServiceRestored?.(service, serviceData);
    }

    // Internet entries first (their order is the entry round-robin order),
    // then the full edge list — re-adding an internet edge is a no-op.
    for (const id of saveData.internetConnections || []) {
        connect("internet", id);
    }
    for (const conn of saveData.connections || []) {
        connect(conn.from, conn.to);
    }
}

// One-call restore of everything the sim owns. Call normalizeSave first.
export function restoreWorld(world, saveData, options = {}) {
    restoreEconomy(world.economy, saveData);
    world.time = saveData.elapsedGameTime ?? 0;
    world.trafficDistribution = { ...saveData.trafficDistribution };
    restoreTopology(world, saveData, options);
}
