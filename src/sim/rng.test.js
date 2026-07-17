import { describe, expect, it } from "vitest";
import { createRngStub, createSeededRng } from "./rng.js";

describe("createSeededRng", () => {
    it("is deterministic for the same seed", () => {
        const a = createSeededRng(42);
        const b = createSeededRng(42);
        for (let i = 0; i < 100; i++) {
            expect(a()).toBe(b());
        }
    });

    it("produces values in [0, 1)", () => {
        const rng = createSeededRng(7);
        for (let i = 0; i < 1000; i++) {
            const v = rng();
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });
});

describe("createRngStub", () => {
    it("returns scripted values, then the fallback forever", () => {
        const rng = createRngStub([0.1, 0.2], 0.9);
        expect(rng()).toBe(0.1);
        expect(rng()).toBe(0.2);
        expect(rng()).toBe(0.9);
        expect(rng()).toBe(0.9);
    });
});
