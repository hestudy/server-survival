// RNG injection for the simulation core (CONTEXT.md: 仿真核心 draws all
// randomness from an injected RNG). An "rng" is any () => number in [0, 1).
// The browser passes Math.random; tests pass a seeded or scripted stub so
// runs are deterministic.

// mulberry32 — small, fast, good-enough PRNG for deterministic replays.
export function createSeededRng(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Scripted stub: returns the given values in order, then the fallback
// forever. Handy for forcing one specific branch (a cache hit, a failure
// roll) while keeping every other draw on the "nothing happens" path.
export function createRngStub(values = [], fallback = 0.999999) {
    let i = 0;
    return () => (i < values.length ? values[i++] : fallback);
}
