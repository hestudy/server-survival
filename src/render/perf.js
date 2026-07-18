// Performance baseline for the render layer (issue #12) — pure logic, no
// DOM, no Three.js, so both pieces are unit-testable and reusable by a
// future mini-game renderer.
//
// The simulation core never sees either of these: the particle budget only
// decides which requests get a mesh, and the quality governor only decides
// renderer settings. particle-cap.parity.test.js pins that down.

// Caps how many request particles are individually rendered. acquire()
// answers "does this new request get a mesh?"; the caller must release()
// with the same answer (and the epoch it acquired under) when the request's
// visual dies. Epochs make delayed releases from a previous game (the 500ms
// death-flash timeout crossing a restart) harmless.
export function createParticleBudget(cap) {
    let visible = 0;
    let hidden = 0;
    let epoch = 0;

    return {
        get cap() {
            return cap;
        },
        get visible() {
            return visible;
        },
        get hidden() {
            return hidden;
        },
        get epoch() {
            return epoch;
        },
        // Lowering the cap never evicts live particles — they drain
        // naturally; only new requests are aggregated.
        setCap(next) {
            cap = next;
        },
        acquire() {
            if (visible < cap) {
                visible++;
                return true;
            }
            hidden++;
            return false;
        },
        release(wasVisible, acquiredEpoch) {
            if (acquiredEpoch !== epoch) return;
            if (wasVisible) visible = Math.max(0, visible - 1);
            else hidden = Math.max(0, hidden - 1);
        },
        reset() {
            visible = 0;
            hidden = 0;
            epoch++;
        },
    };
}

// Watches real (unscaled) frame times and steps the quality tier (降阶档位)
// 0 = full quality … tierCount-1 = lowest. Degrades after fps stays below
// degradeBelowFps for degradeAfterSeconds; recovers after fps stays above
// recoverAboveFps for recoverAfterSeconds. The wide hysteresis band between
// the two thresholds, a cooldown after every change, and a recovery
// requirement that doubles per degrade keep the tier from flapping — tier
// changes are applied between frames, so the player is never interrupted.
export function createQualityGovernor({
    tierCount,
    degradeBelowFps,
    degradeAfterSeconds,
    recoverAboveFps,
    recoverAfterSeconds,
    cooldownSeconds,
    onChange = () => {},
} = {}) {
    let tier = 0;
    let emaFps = 60;
    let lowTime = 0;
    let highTime = 0;
    let cooldown = 0;
    // Anti-flap: every degrade doubles the healthy stretch required to earn
    // the next recovery (capped so recovery stays reachable).
    let recoverNeed = recoverAfterSeconds;

    function setTier(next) {
        tier = next;
        cooldown = cooldownSeconds;
        lowTime = 0;
        highTime = 0;
        onChange(tier);
    }

    return {
        get tier() {
            return tier;
        },
        get fps() {
            return emaFps;
        },
        // dt: seconds since the previous frame, real time (not game time —
        // timeScale/pause must not look like lag). Pathological gaps (tab in
        // background, clock jumps) are ignored entirely.
        frame(dt) {
            if (!(dt > 0) || dt > 0.5) return;

            const instFps = 1 / dt;
            // Time-based smoothing: ~1s to absorb a change regardless of
            // frame rate.
            const alpha = Math.min(1, dt * 2);
            emaFps += (instFps - emaFps) * alpha;

            if (cooldown > 0) cooldown = Math.max(0, cooldown - dt);

            if (emaFps < degradeBelowFps) {
                lowTime += dt;
                highTime = 0;
                if (
                    cooldown === 0 &&
                    lowTime >= degradeAfterSeconds &&
                    tier < tierCount - 1
                ) {
                    recoverNeed = Math.min(recoverNeed * 2, recoverAfterSeconds * 8);
                    setTier(tier + 1);
                }
            } else if (emaFps > recoverAboveFps) {
                highTime += dt;
                lowTime = 0;
                if (cooldown === 0 && highTime >= recoverNeed && tier > 0) {
                    setTier(tier - 1);
                }
            } else {
                lowTime = 0;
                highTime = 0;
            }
        },
    };
}
