// SimWorld construction contract: id uniqueness across save restores, and
// the mandatory RNG injection.
import { describe, expect, it } from "vitest";
import { SimWorld } from "./world.js";
import { makeWorld } from "./test-helpers.js";

describe("service id allocation", () => {
    it("never re-mints an id claimed by a restored save (save/load collision fix)", () => {
        const { world } = makeWorld();
        // A save written by the sequential-id scheme can hold ids beyond the
        // current sequence (services deleted after their successors were
        // placed). Restoring must advance the sequence past every claimed id.
        world.addService("waf"); // svc_1
        world.claimServiceId("svc_5");

        const next = world.addService("alb");
        expect(next.id).toBe("svc_6");
        const ids = world.services.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("ignores pre-refactor random-format ids, which cannot collide with the counter", () => {
        const { world } = makeWorld();
        world.claimServiceId("svc_k3j2h1g9x");
        expect(world.addService("waf").id).toBe("svc_1");
    });
});

describe("rng injection", () => {
    it("refuses construction without an injected rng", () => {
        expect(() => new SimWorld()).toThrow(TypeError);
        expect(() => new SimWorld({ rng: 0.5 })).toThrow(TypeError);
    });
});
