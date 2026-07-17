// Save serialization tests (issue #5, M1-c): the sim core owns the save
// schema. The localStorage key and the on-disk format must stay exactly what
// the pre-refactor web layer wrote — old saves keep loading, new saves stay
// loadable by shape. Round-trip: serialize → deserialize → same world.
import { describe, expect, it } from "vitest";
import {
    SAVE_KEY,
    SAVE_VERSION,
    buildSaveData,
    normalizeSave,
    restoreWorld,
} from "./save.js";
import { makeWorld, runUntilDrained, wire } from "./test-helpers.js";
import v1Legacy from "./fixtures/save-v1-legacy.json";
import v2PreRefactor from "./fixtures/save-v2-prerefactor.json";

// Deep-copy a fixture so normalizeSave's in-place migration can't leak
// between tests.
const load = (fixture) => JSON.parse(JSON.stringify(fixture));

function makePlayedWorld() {
    const { world, economy } = makeWorld();
    const waf = world.addService("waf");
    const alb = world.addService("alb");
    const compute = world.addService("compute");
    const db = world.addService("db");
    const s3 = world.addService("s3");
    wire(world, "internet", waf);
    wire(world, waf, alb);
    wire(world, alb, compute);
    wire(world, compute, db);
    wire(world, compute, s3);

    // Simulate an upgraded DB the way the web layer does it.
    db.tier = 2;
    db.config = { ...db.config, capacity: 20 };

    economy.upkeepEnabled = false; // keep the money assertions round
    world.spawnRequest("READ");
    world.spawnRequest("UPLOAD");
    world.spawnRequest("MALICIOUS");
    runUntilDrained(world);

    return { world, economy, waf, alb, compute, db, s3 };
}

describe("save format contract", () => {
    it("keeps the pre-refactor localStorage key and version", () => {
        expect(SAVE_KEY).toBe("serverSurvivalSave");
        expect(SAVE_VERSION).toBe("2.0");
    });

    it("produces the pre-refactor payload shape", () => {
        const { world, waf } = makePlayedWorld();

        const saveData = buildSaveData({
            timestamp: 1752700000000,
            state: { activeTool: "select", gameMode: "survival", autoRepairEnabled: true },
            world,
        });

        expect(saveData.timestamp).toBe(1752700000000);
        expect(saveData.version).toBe(SAVE_VERSION);
        // Web-layer state passes through untouched.
        expect(saveData.activeTool).toBe("select");
        expect(saveData.gameMode).toBe("survival");
        expect(saveData.autoRepairEnabled).toBe(true);
        // Sim-owned fields are written explicitly.
        expect(saveData.money).toBe(world.economy.money);
        expect(saveData.reputation).toBe(world.economy.reputation);
        expect(saveData.score).toEqual(world.economy.score);
        expect(saveData.finances).toEqual(world.economy.finances);
        expect(saveData.requests).toEqual([]);
        expect(saveData.internetConnections).toEqual([waf.id]);
        expect(saveData.services[0]).toEqual({
            id: waf.id,
            type: "waf",
            position: [0, 0, 0],
            connections: [...waf.connections],
            tier: 1,
            cacheHitRate: null,
        });
        expect(saveData.connections).toContainEqual({ from: "internet", to: waf.id });
        // The payload must survive JSON round-tripping unchanged.
        expect(JSON.parse(JSON.stringify(saveData))).toEqual(saveData);
    });

    it("records tier and cacheHitRate per service", () => {
        const { world } = makeWorld();
        const cache = world.addService("cache");
        const db = world.addService("db");
        db.tier = 3;

        const saveData = buildSaveData({ timestamp: 1, state: {}, world });

        expect(saveData.services).toEqual([
            expect.objectContaining({ type: "cache", cacheHitRate: 0.35 }),
            expect.objectContaining({ type: "db", tier: 3 }),
        ]);
    });
});

describe("save round-trip (serialize → deserialize → same state)", () => {
    it("restores topology, tiers, economy and traffic mix identically", () => {
        const source = makePlayedWorld();
        const saveData = JSON.parse(
            JSON.stringify(
                buildSaveData({
                    timestamp: 42,
                    state: { gameMode: "survival" },
                    world: source.world,
                })
            )
        );

        const { world: restored } = makeWorld();
        restoreWorld(restored, normalizeSave(saveData));

        expect(restored.services.map((s) => [s.id, s.type, s.tier])).toEqual(
            source.world.services.map((s) => [s.id, s.type, s.tier])
        );
        // Tier-2 DB gets its tier config back.
        const db = restored.services.find((s) => s.type === "db");
        expect(db.config.capacity).toBe(20);
        // Connections (entry order included) survive.
        expect(restored.internet.connections).toEqual(
            source.world.internet.connections
        );
        for (const [i, s] of restored.services.entries()) {
            expect(s.connections).toEqual(source.world.services[i].connections);
        }
        // Economy state survives.
        expect(restored.economy.money).toBe(source.economy.money);
        expect(restored.economy.reputation).toBe(source.economy.reputation);
        expect(restored.economy.score).toEqual(source.economy.score);
        expect(restored.economy.finances).toEqual(source.economy.finances);
        expect(restored.trafficDistribution).toEqual(
            source.world.trafficDistribution
        );
        expect(restored.time).toBe(source.world.time);

        // The restored world is playable: the same request settles the same.
        restored.economy.upkeepEnabled = false;
        restored.spawnRequest("READ");
        runUntilDrained(restored);
        expect(restored.stats.completed).toBe(1);
    });

    it("continues the service id sequence after restoring sequential ids", () => {
        const source = makeWorld().world;
        source.addService("waf"); // svc_1
        source.addService("alb"); // svc_2
        const saveData = buildSaveData({ timestamp: 1, state: {}, world: source });

        const { world: restored } = makeWorld();
        restoreWorld(restored, normalizeSave(saveData));
        const next = restored.addService("compute");

        expect(new Set(restored.services.map((s) => s.id)).size).toBe(3);
        expect(next.id).toBe("svc_3");
    });
});

describe("backward compatibility with pre-refactor saves", () => {
    it("loads a real pre-refactor v2.0 save (random service ids, full state)", () => {
        const { world } = makeWorld();
        restoreWorld(world, normalizeSave(load(v2PreRefactor)));

        expect(world.services).toHaveLength(6);
        expect(world.services.map((s) => s.id)).toContain("svc_a8k2j9x4q");
        // Tiered services get their tier configs reapplied.
        const compute = world.services.find((s) => s.type === "compute");
        expect(compute.tier).toBe(2);
        expect(compute.config.capacity).toBe(10);
        const db = world.services.find((s) => s.type === "db");
        expect(db.tier).toBe(3);
        expect(db.config.capacity).toBe(35);
        // Entry points restored in order (WAF first, CDN second).
        expect(world.internet.connections).toEqual([
            "svc_a8k2j9x4q",
            "svc_p3m7n1c5d",
        ]);
        // Economy restored.
        expect(world.economy.money).toBe(312.4567);
        expect(world.economy.reputation).toBe(87.3);
        expect(world.economy.score).toEqual({
            total: 693,
            storage: 210,
            database: 385,
            maliciousBlocked: 98,
        });
        expect(world.time).toBe(254.8);

        // Old random-format ids must not confuse the id sequence.
        const fresh = world.addService("cache");
        expect(world.services.filter((s) => s.id === fresh.id)).toHaveLength(1);
    });

    it("migrates a v1 legacy save (WEB/API/FRAUD era) on load", () => {
        const saveData = normalizeSave(load(v1Legacy));

        expect(saveData.trafficDistribution).toEqual({
            STATIC: 0.5,
            READ: 0.3 * 0.5,
            WRITE: 0.3 * 0.3,
            UPLOAD: 0.05,
            SEARCH: 0.3 * 0.2,
            MALICIOUS: 0.2,
        });
        expect(saveData.score).toEqual({
            total: 180,
            storage: 90,
            database: 60,
            maliciousBlocked: 30,
        });
        expect(saveData.maliciousSpikeTimer).toBe(12.5);
        expect(saveData.maliciousSpikeActive).toBe(false);
        expect("fraudSpikeTimer" in saveData).toBe(false);

        const { world } = makeWorld();
        restoreWorld(world, saveData);
        expect(world.services).toHaveLength(4);
        expect(world.economy.score.storage).toBe(90);
        expect(world.trafficDistribution.STATIC).toBe(0.5);
    });

    it("leaves current-version saves untouched by migration", () => {
        const saveData = load(v2PreRefactor);
        expect(normalizeSave(saveData)).toEqual(load(v2PreRefactor));
    });
});

describe("historical regressions", () => {
    it("存档丢财务状态: the finance ledger and maintenance state survive save/load", () => {
        // The historical bug: loading always zeroed STATE.finances even though
        // the save carried it, wiping income/expense history (and the
        // auto-repair maintenance state with it).
        const { world } = makeWorld();
        restoreWorld(world, normalizeSave(load(v2PreRefactor)));

        expect(world.economy.finances).toEqual(v2PreRefactor.finances);
        // Maintenance state travels in the payload for the web layer.
        expect(v2PreRefactor.autoRepairEnabled).toBe(true);
        expect(v2PreRefactor.upkeepEnabled).toBe(true);

        // …and a fresh save written from the restored world still carries it.
        const resaved = buildSaveData({
            timestamp: 2,
            state: { autoRepairEnabled: true, upkeepEnabled: true },
            world,
        });
        expect(resaved.finances).toEqual(v2PreRefactor.finances);
        expect(resaved.autoRepairEnabled).toBe(true);
    });

    it("存档丢财务状态: saves that predate finance tracking restore zeroed ledgers", () => {
        const saveData = normalizeSave(load(v1Legacy));
        const { world } = makeWorld();
        restoreWorld(world, saveData);

        const finances = world.economy.finances;
        expect(finances.income.total).toBe(0);
        expect(finances.expenses.upkeep).toBe(0);
        expect(finances.expenses.mitigation).toBe(0);
        expect(finances.expenses.breach).toBe(0);
        expect(finances.expenses.byService.serverless).toBe(0);
    });

    it("merges partial finance blocks from older saves over zeroed defaults", () => {
        // Saves written between finance-tracking versions can miss newer keys
        // (mitigation/breach, serverless buckets); they must default to 0,
        // not undefined.
        const saveData = load(v2PreRefactor);
        delete saveData.finances.expenses.mitigation;
        delete saveData.finances.expenses.breach;

        const { world } = makeWorld();
        restoreWorld(world, normalizeSave(saveData));

        expect(world.economy.finances.expenses.mitigation).toBe(0);
        expect(world.economy.finances.expenses.breach).toBe(0);
        expect(world.economy.finances.expenses.upkeep).toBe(61.2345);
    });
});
