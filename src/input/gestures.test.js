// Seam 2 (issue #8): the gesture recognition layer is tested by feeding
// synthetic normalized pointer-event sequences and asserting the semantic
// intents that come out — never by touching the DOM. Boundaries under test:
// the tap slop tolerance, the tap max duration, the ~350ms long-press ("lift")
// threshold, and the pinch/pan conflict-resolution rules.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGestureRecognizer } from "./gestures.js";

const INTENTS = [
    "onTap",
    "onLift",
    "onLiftDrag",
    "onLiftDrop",
    "onLiftCancel",
    "onPress",
    "onDrag",
    "onRelease",
    "onHover",
    "onHoverEnd",
    "onPanStart",
    "onPan",
    "onPanEnd",
    "onPinchStart",
    "onPinch",
    "onPinchEnd",
    "onZoom",
    "onCancel",
];

// Records every emitted intent as [name, payload] so tests can assert both
// presence and ordering.
function recorder(opts) {
    const log = [];
    const handlers = {};
    for (const name of INTENTS) {
        handlers[name] = (payload) => log.push([name, payload]);
    }
    const rec = createGestureRecognizer(handlers, opts);
    const names = () => log.map(([name]) => name);
    const of = (name) =>
        log.filter(([n]) => n === name).map(([, payload]) => payload);
    return { rec, log, names, of };
}

const touch = (type, touches, time = 0) => ({ type, touches, time });
const pt = (x, y) => ({ x, y });

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("tap (点选)", () => {
    it("a quick touch within the slop emits a tap at the last position", () => {
        const { rec, names, of } = recorder();
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        rec.handle(touch("touch-move", [pt(104, 103)], 50));
        rec.handle(touch("touch-end", [], 120));
        expect(of("onTap")).toEqual([{ x: 104, y: 103 }]);
        expect(names()).not.toContain("onPanStart");
        expect(names()).not.toContain("onPan");
        expect(names()).not.toContain("onPinchStart");
        expect(names()).not.toContain("onPress");
    });

    it("drift exactly at the slop boundary is still a tap", () => {
        const { rec, of } = recorder({ tapSlopPx: 12 });
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        rec.handle(touch("touch-move", [pt(112, 100)], 60)); // dist == 12
        rec.handle(touch("touch-end", [], 100));
        expect(of("onTap")).toEqual([{ x: 112, y: 100 }]);
    });

    it("drift beyond the slop cancels the tap and becomes a pan", () => {
        const { rec, names } = recorder({ tapSlopPx: 12 });
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        rec.handle(touch("touch-move", [pt(113, 100)], 60)); // dist == 13
        rec.handle(touch("touch-end", [], 100));
        expect(names()).not.toContain("onTap");
        expect(names()).toContain("onPanStart");
        expect(names()).toContain("onPanEnd");
    });

    it("a hold released at exactly tapMaxMs still taps; one ms later does not", () => {
        for (const [duration, tapped] of [
            [500, true],
            [501, false],
        ]) {
            const { rec, of } = recorder({
                tapMaxMs: 500,
                longPressEnabled: false,
            });
            rec.handle(touch("touch-start", [pt(50, 50)], 1000));
            rec.handle(touch("touch-end", [], 1000 + duration));
            expect(of("onTap").length).toBe(tapped ? 1 : 0);
        }
    });

    it("release before the long-press threshold taps even with lift enabled", () => {
        const { rec, of, names } = recorder({ longPressMs: 350 });
        rec.handle(touch("touch-start", [pt(10, 20)], 0));
        vi.advanceTimersByTime(300);
        rec.handle(touch("touch-end", [], 300));
        expect(of("onTap")).toEqual([{ x: 10, y: 20 }]);
        expect(names()).not.toContain("onLift");
    });
});

describe("long-press (抬起)", () => {
    it("holding still for longPressMs emits a lift at the finger position", () => {
        const { rec, of, names } = recorder({ longPressMs: 350 });
        rec.handle(touch("touch-start", [pt(200, 150)], 0));
        vi.advanceTimersByTime(349);
        expect(names()).not.toContain("onLift");
        vi.advanceTimersByTime(1);
        expect(of("onLift")).toEqual([{ x: 200, y: 150 }]);
    });

    it("drift within the slop keeps the long-press armed", () => {
        const { rec, of } = recorder({ tapSlopPx: 12, longPressMs: 350 });
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        rec.handle(touch("touch-move", [pt(105, 104)], 100));
        vi.advanceTimersByTime(350);
        expect(of("onLift")).toEqual([{ x: 105, y: 104 }]);
    });

    it("exceeding the slop before the threshold cancels the lift and pans", () => {
        const { rec, names } = recorder({ tapSlopPx: 12, longPressMs: 350 });
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        rec.handle(touch("touch-move", [pt(130, 100)], 200));
        vi.advanceTimersByTime(1000);
        expect(names()).not.toContain("onLift");
        expect(names()).toContain("onPanStart");
    });

    it("after a lift, movement is a lift-drag (never a pan) and release drops", () => {
        const { rec, names, of } = recorder({ longPressMs: 350 });
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        vi.advanceTimersByTime(350);
        rec.handle(touch("touch-move", [pt(140, 110)], 400));
        rec.handle(touch("touch-move", [pt(150, 115)], 450));
        rec.handle(touch("touch-end", [], 500));
        expect(of("onLiftDrag")).toEqual([
            { x: 140, y: 110, dx: 40, dy: 10 },
            { x: 150, y: 115, dx: 10, dy: 5 },
        ]);
        expect(of("onLiftDrop")).toEqual([{ x: 150, y: 115 }]);
        expect(names()).not.toContain("onPan");
        expect(names()).not.toContain("onTap");
    });

    it("longPressEnabled: false never lifts — a held single-finger drag is a pan", () => {
        const { rec, names } = recorder({ longPressEnabled: false });
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        vi.advanceTimersByTime(2000);
        rec.handle(touch("touch-move", [pt(160, 100)], 2000));
        rec.handle(touch("touch-end", [], 2100));
        expect(names()).not.toContain("onLift");
        expect(names()).not.toContain("onLiftDrag");
        expect(names()).toContain("onPanStart");
        expect(names()).toContain("onPan");
    });
});

describe("single-finger pan (平移)", () => {
    it("pan deltas are measured from the previous move, not the start", () => {
        const { rec, of } = recorder({ tapSlopPx: 12 });
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        rec.handle(touch("touch-move", [pt(105, 100)], 20)); // within slop: silent
        rec.handle(touch("touch-move", [pt(120, 100)], 40)); // crosses slop
        rec.handle(touch("touch-move", [pt(125, 103)], 60));
        rec.handle(touch("touch-end", [], 80));
        expect(of("onPanStart")).toEqual([{ pointerType: "touch" }]);
        expect(of("onPan")).toEqual([
            { dx: 15, dy: 0, pointerType: "touch" },
            { dx: 5, dy: 3, pointerType: "touch" },
        ]);
        expect(of("onPanEnd")).toEqual([{ pointerType: "touch" }]);
    });
});

describe("pinch (捏合) and conflict resolution", () => {
    it("two fingers emit pinch scale + midpoint deltas, never pan or tap", () => {
        const { rec, names, of } = recorder();
        rec.handle(touch("touch-start", [pt(100, 100), pt(200, 100)], 0));
        rec.handle(touch("touch-move", [pt(90, 100), pt(210, 100)], 30));
        rec.handle(touch("touch-move", [pt(100, 100), pt(220, 100)], 60));
        rec.handle(touch("touch-end", [], 90));
        expect(of("onPinchStart").length).toBe(1);
        const pinches = of("onPinch");
        expect(pinches[0].scale).toBeCloseTo(1.2);
        expect(pinches[0].dx).toBe(0);
        expect(pinches[0].dy).toBe(0);
        expect(pinches[1].scale).toBeCloseTo(1.0);
        expect(pinches[1].dx).toBe(10);
        expect(pinches[1].dy).toBe(0);
        expect(of("onPinchEnd").length).toBe(1);
        expect(names()).not.toContain("onPan");
        expect(names()).not.toContain("onTap");
    });

    it("a second finger during a pending tap kills the tap even on quick release", () => {
        const { rec, names } = recorder({ tapMaxMs: 500 });
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        rec.handle(touch("touch-start", [pt(150, 100), pt(100, 100)], 50));
        rec.handle(touch("touch-end", [], 100)); // both up well within tapMaxMs
        expect(names()).not.toContain("onTap");
        expect(names()).toContain("onPinchStart");
    });

    it("a second finger during a pan closes the pan before the pinch starts", () => {
        const { rec, names } = recorder({ tapSlopPx: 12 });
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        rec.handle(touch("touch-move", [pt(130, 100)], 30));
        rec.handle(touch("touch-start", [pt(130, 100), pt(200, 100)], 60));
        rec.handle(touch("touch-move", [pt(130, 110), pt(200, 110)], 90));
        const order = names();
        expect(order.indexOf("onPanEnd")).toBeGreaterThan(
            order.indexOf("onPanStart")
        );
        expect(order.indexOf("onPinchStart")).toBeGreaterThan(
            order.indexOf("onPanEnd")
        );
        // Midpoint movement during the pinch must not leak as pan intents.
        expect(order.filter((n) => n === "onPan").length).toBe(1);
    });

    it("the long-press timer never fires once a pinch has started", () => {
        const { rec, names } = recorder({ longPressMs: 350 });
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        rec.handle(touch("touch-start", [pt(100, 100), pt(200, 100)], 100));
        vi.advanceTimersByTime(1000);
        expect(names()).not.toContain("onLift");
    });

    it("a second finger cancels an active lift and starts a pinch", () => {
        const { rec, names } = recorder({ longPressMs: 350 });
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        vi.advanceTimersByTime(350);
        rec.handle(touch("touch-start", [pt(100, 100), pt(200, 100)], 400));
        expect(names()).toContain("onLift");
        expect(names()).toContain("onLiftCancel");
        expect(names()).toContain("onPinchStart");
        expect(names()).not.toContain("onLiftDrop");
    });

    it("pinch → one finger up re-anchors the survivor as a pan with no jump", () => {
        const { rec, of, names } = recorder();
        rec.handle(touch("touch-start", [pt(100, 100), pt(210, 100)], 0));
        rec.handle(touch("touch-end", [pt(210, 100)], 50)); // first finger up
        rec.handle(touch("touch-move", [pt(215, 104)], 80));
        rec.handle(touch("touch-end", [], 110));
        expect(names()).toContain("onPinchEnd");
        expect(of("onPan")).toEqual([{ dx: 5, dy: 4, pointerType: "touch" }]);
        expect(names()).not.toContain("onTap");
    });
});

describe("mouse normalization (桌面冻结)", () => {
    it("left button maps to press / drag / release with no touch-side intents", () => {
        const { rec, of, names } = recorder();
        rec.handle({ type: "mouse-down", x: 100, y: 100, button: 0 });
        rec.handle({ type: "mouse-move", x: 102, y: 101 }); // no slop for mouse
        rec.handle({ type: "mouse-move", x: 110, y: 105 });
        rec.handle({ type: "mouse-up", x: 110, y: 105, button: 0 });
        expect(of("onPress")).toEqual([{ x: 100, y: 100 }]);
        expect(of("onDrag")).toEqual([
            { x: 102, y: 101, dx: 2, dy: 1 },
            { x: 110, y: 105, dx: 8, dy: 4 },
        ]);
        expect(of("onRelease")).toEqual([{ x: 110, y: 105 }]);
        expect(names()).not.toContain("onTap");
        expect(names()).not.toContain("onPanStart");
        expect(names()).not.toContain("onHover");
    });

    it("movement without buttons is hover; leaving the surface ends it", () => {
        const { rec, of } = recorder();
        rec.handle({ type: "mouse-move", x: 30, y: 40 });
        rec.handle({ type: "mouse-leave" });
        expect(of("onHover")).toEqual([{ x: 30, y: 40 }]);
        expect(of("onHoverEnd").length).toBe(1);
    });

    it.each([1, 2])("button %i drag maps to mouse pan intents", (button) => {
        const { rec, of } = recorder();
        rec.handle({ type: "mouse-down", x: 100, y: 100, button });
        rec.handle({ type: "mouse-move", x: 90, y: 106 });
        rec.handle({ type: "mouse-up", x: 90, y: 106, button });
        expect(of("onPanStart")).toEqual([{ pointerType: "mouse" }]);
        expect(of("onPan")).toEqual([
            { dx: -10, dy: 6, pointerType: "mouse" },
        ]);
        expect(of("onPanEnd")).toEqual([{ pointerType: "mouse" }]);
    });

    it("every mouse-up also emits a release, mirroring the raw mouseup contract", () => {
        // game.js finalizes an in-flight node drag on any mouseup, whatever the
        // button — the recognizer preserves that by always emitting onRelease.
        const { rec, of } = recorder();
        rec.handle({ type: "mouse-down", x: 100, y: 100, button: 2 });
        rec.handle({ type: "mouse-up", x: 100, y: 100, button: 2 });
        expect(of("onRelease")).toEqual([{ x: 100, y: 100 }]);
    });

    it("wheel maps to a zoom intent", () => {
        const { rec, of } = recorder();
        rec.handle({ type: "wheel", x: 55, y: 66, deltaY: -120 });
        expect(of("onZoom")).toEqual([{ deltaY: -120, x: 55, y: 66 }]);
    });
});

// Issue #9 acceptance: aggressive play (rapid taps, tapping mid-pan) must
// never be misread as a lift — a service moves only after a deliberate,
// still long-press.
describe("aggressive interactions never lift (issue #9)", () => {
    it("rapid consecutive taps all tap and never arm a lift", () => {
        const { rec, of, names } = recorder({ longPressMs: 350 });
        let t = 0;
        for (let i = 0; i < 5; i++) {
            rec.handle(touch("touch-start", [pt(100 + i, 100)], t));
            vi.advanceTimersByTime(80);
            t += 80;
            rec.handle(touch("touch-end", [], t));
            vi.advanceTimersByTime(60);
            t += 60;
        }
        vi.advanceTimersByTime(1000);
        expect(of("onTap").length).toBe(5);
        expect(names()).not.toContain("onLift");
    });

    it("the lift timer dies with the touch that armed it", () => {
        const { rec, names } = recorder({ longPressMs: 350 });
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        vi.advanceTimersByTime(100);
        rec.handle(touch("touch-end", [], 100)); // tap released early
        rec.handle(touch("touch-start", [pt(150, 150)], 200));
        rec.handle(touch("touch-move", [pt(190, 150)], 250)); // crosses slop
        vi.advanceTimersByTime(1000); // the first touch's timer would fire here
        expect(names()).not.toContain("onLift");
        expect(names()).not.toContain("onLiftDrag");
        expect(names()).toContain("onPanStart");
    });

    it("a tap right after finishing a pan is a tap, not a lift-drag", () => {
        const { rec, of, names } = recorder({ tapSlopPx: 12, longPressMs: 350 });
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        rec.handle(touch("touch-move", [pt(160, 100)], 50));
        rec.handle(touch("touch-move", [pt(200, 120)], 100));
        rec.handle(touch("touch-end", [], 150));
        rec.handle(touch("touch-start", [pt(210, 130)], 180));
        vi.advanceTimersByTime(100);
        rec.handle(touch("touch-end", [], 280));
        expect(of("onTap")).toEqual([{ x: 210, y: 130 }]);
        expect(names()).not.toContain("onLift");
        expect(names()).not.toContain("onLiftDrag");
    });

    it("a stray second-finger tap mid-pan never taps, lifts, or drags a node", () => {
        const { rec, names } = recorder({
            tapSlopPx: 12,
            longPressMs: 350,
            tapMaxMs: 500,
        });
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        rec.handle(touch("touch-move", [pt(140, 100)], 50)); // panning
        rec.handle(touch("touch-start", [pt(140, 100), pt(300, 300)], 100)); // stray tap lands
        rec.handle(touch("touch-end", [pt(140, 100)], 160)); // and leaves quickly
        rec.handle(touch("touch-move", [pt(150, 110)], 200));
        vi.advanceTimersByTime(1000);
        rec.handle(touch("touch-end", [], 1200));
        expect(names()).not.toContain("onTap");
        expect(names()).not.toContain("onLift");
        expect(names()).not.toContain("onLiftDrag");
    });
});

describe("cancellation and stray events", () => {
    it("touch-cancel resets the machine and emits onCancel; next tap still works", () => {
        const { rec, of, names } = recorder();
        rec.handle(touch("touch-start", [pt(100, 100)], 0));
        rec.handle({ type: "touch-cancel" });
        expect(names()).toContain("onCancel");
        rec.handle(touch("touch-start", [pt(50, 50)], 500));
        rec.handle(touch("touch-end", [], 550));
        expect(of("onTap")).toEqual([{ x: 50, y: 50 }]);
    });

    it("a touch-move with no preceding touch-start is ignored", () => {
        const { rec, log } = recorder();
        rec.handle(touch("touch-move", [pt(10, 10)], 0));
        expect(log).toEqual([]);
    });
});
