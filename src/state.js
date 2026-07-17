import { SimWorld } from "./sim/world.js";

// The simulation-core world (seam 1, ADR-0002). One shared instance: the
// browser injects Math.random; game.js wires the lifecycle hooks and the
// renderable-request factory at startup.
const world = new SimWorld({
    rng: Math.random,
    trafficDistribution: {
        STATIC: 0.30,
        READ: 0.20,
        WRITE: 0.15,
        UPLOAD: 0.05,
        SEARCH: 0.10,
        MALICIOUS: 0.20
    }
});

const STATE = {
    money: 0,
    reputation: 0,
    requestsProcessed: 0,

    score: {
        total: 0,
        storage: 0,
        database: 0,
        maliciousBlocked: 0
    },

    failures: {
        STATIC: 0,
        READ: 0,
        WRITE: 0,
        UPLOAD: 0,
        SEARCH: 0,
        MALICIOUS: 0
    },

    activeTool: 'select',
    selectedNodeId: null,
    connections: [],

    lastTime: 0,
    spawnTimer: 0,
    currentRPS: 0.5,
    timeScale: 1,
    isRunning: true,
    animationId: null,

    internetNode: {
        id: 'internet',
        type: 'internet',
        position: new THREE.Vector3(
            CONFIG.internetNodeStartPos.x,
            CONFIG.internetNodeStartPos.y,
            CONFIG.internetNodeStartPos.z
        ),
        // The connection list itself lives in the sim world.
        get connections() { return world.internet.connections; },
        set connections(v) { world.internet.connections = v; }
    },

    sound: null,

    // Sandbox mode state
    gameMode: 'survival',
    sandboxBudget: 2000,
    upkeepEnabled: true,
    burstCount: 10,

    // Menu state
    gameStarted: false,
    previousTimeScale: 1,

    // Balance overhaul state
    gameStartTime: 0,
    elapsedGameTime: 0,
    maliciousSpikeTimer: 0,
    maliciousSpikeActive: false,
    normalTrafficDist: null,

    // Intervention mechanics state
    intervention: {
        // Traffic shift state
        trafficShiftTimer: 0,
        trafficShiftActive: false,
        currentShift: null,
        originalTrafficDist: null,

        // Random events state
        randomEventTimer: 0,
        activeEvent: null,
        eventEndTime: 0,
        pausedEvent: null,
        remainingTime: 0,

        // RPS milestone tracking
        currentMilestoneIndex: 0,
        rpsMultiplier: 1.0,

        // Event history for UI
        recentEvents: [],

        // Warning state
        warnings: []
    },

    // Campaign mode runtime state. Populated by CampaignController when active.
    campaign: {
        active: false,
        currentLevelId: null,
        level: null,            // level config object
        objectiveResults: {},   // { objectiveId: boolean }
        bonusResults: {},
        startedAt: 0,
        ended: false,
        outcome: null,          // "win" | "lose" | null
        failureReason: null,
    }
};

// Transitional aliases (ADR-0002 expand step): the legacy code reads and
// reassigns STATE.services / STATE.requests / STATE.trafficDistribution all
// over, but the arrays now live in the sim world — these accessors keep both
// layers on one source of truth. Deliberately non-enumerable: the world holds
// circular references, and saveGameState spreads STATE into the save payload
// (it lists services/requests/trafficDistribution explicitly).
Object.defineProperties(STATE, {
    world: {
        value: world,
    },
    services: {
        get() { return world.services; },
        set(v) { world.services = v; },
    },
    requests: {
        get() { return world.requests; },
        set(v) { world.requests = v; },
    },
    trafficDistribution: {
        get() { return world.trafficDistribution; },
        set(v) { world.trafficDistribution = v; },
    },
});

// Transitional global bridge (ADR-0002 expand step): shared with the other
// legacy scripts, which still resolve this as a global.
window.STATE = STATE;
