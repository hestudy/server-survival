// Platform adapter: storage (ADR-0002, issue #7). Direct localStorage access
// is allowed only in this file — save slots, campaign progress, tutorial
// completion and locale choice all go through `storage`, so the mini-game
// port swaps this implementation (wx.getStorageSync et al.) without touching
// callers. Synchronous string API, mirroring localStorage; keys and formats
// are owned by the callers and stay exactly what they were.

function createWebStorage() {
    return {
        get(key) {
            return localStorage.getItem(key);
        },
        set(key, value) {
            localStorage.setItem(key, value);
        },
        remove(key) {
            localStorage.removeItem(key);
        },
    };
}

// Headless fallback (Node/Vitest): same interface, process-lifetime memory.
function createMemoryStorage() {
    const items = new Map();
    return {
        get(key) {
            return items.has(key) ? items.get(key) : null;
        },
        set(key, value) {
            items.set(key, String(value));
        },
        remove(key) {
            items.delete(key);
        },
    };
}

export const storage =
    typeof localStorage === "undefined"
        ? createMemoryStorage()
        : createWebStorage();
