// Gesture recognition layer (输入层, issue #8): a pure state machine that
// turns a normalized raw pointer-event stream into semantic intents. It is
// the "seam 2" of the mobile spec — no DOM, no Three.js, no platform
// adapters; the only environment dependency is the setTimeout pair driving
// the long-press threshold. The platform input adapter feeds it plain
// objects and the game consumes the intents it emits.
//
// Raw events accepted by handle():
//   { type: "touch-start" | "touch-move" | "touch-end", touches: [{x, y}…], time }
//     `touches` mirrors TouchEvent.touches: the fingers still on the surface.
//     `time` is a monotonic ms clock (performance.now()), used for the tap
//     duration check.
//   { type: "touch-cancel" }
//   { type: "mouse-down" | "mouse-up", x, y, button }
//   { type: "mouse-move", x, y }
//   { type: "mouse-leave" }
//   { type: "wheel", x, y, deltaY }
//
// Touch intents: onTap (点选), onLift (抬起, after ~350ms of holding still),
// onLiftDrag/onLiftDrop/onLiftCancel (拖动 of a lifted node), onPanStart/
// onPan/onPanEnd (平移), onPinchStart/onPinch/onPinchEnd (捏合), onCancel.
//
// Conflict-resolution rules, each locked by a unit test:
//   - a tap dies the moment the finger drifts past tapSlopPx or a second
//     finger lands — a pinch can never end in a stray tap or pan;
//   - single-finger movement past the slop is always a pan (never a node
//     drag) unless a lift already happened;
//   - pinch midpoint movement travels inside the pinch intent, not as pan;
//   - when a pinch loses a finger the survivor is re-anchored as a pan so
//     the camera doesn't jump.
//
// Mouse intents (onPress/onDrag/onRelease/onHover/onHoverEnd, pan for
// right/middle drag, onZoom for wheel) are deliberately a thin normalization:
// desktop behavior is a frozen baseline, so mouse events keep their
// act-immediately semantics (no slop, no long-press) and the consumer keeps
// deciding what a press over a service means.

export const TAP_SLOP_PX = 12;
export const TAP_MAX_MS = 500;
export const LONG_PRESS_MS = 350;

export function createGestureRecognizer(handlers = {}, opts = {}) {
    const {
        tapSlopPx = TAP_SLOP_PX,
        tapMaxMs = TAP_MAX_MS,
        longPressMs = LONG_PRESS_MS,
        longPressEnabled = true,
    } = opts;

    const emit = (name, payload) => {
        if (handlers[name]) handlers[name](payload);
    };

    // --- touch track: idle | pending | pan | lifted | pinch ---
    let touchState = "idle";
    let startX = 0, startY = 0, startTime = 0;
    let lastX = 0, lastY = 0;
    let pinchDist = 0, pinchMidX = 0, pinchMidY = 0;
    let liftTimer = null;

    // --- mouse track ---
    let leftDown = false;
    let mousePanning = false;
    let mouseLastX = 0, mouseLastY = 0;

    function clearLiftTimer() {
        if (liftTimer !== null) {
            clearTimeout(liftTimer);
            liftTimer = null;
        }
    }

    function armLiftTimer() {
        if (!longPressEnabled) return;
        liftTimer = setTimeout(() => {
            liftTimer = null;
            if (touchState === "pending") {
                touchState = "lifted";
                emit("onLift", { x: lastX, y: lastY });
            }
        }, longPressMs);
    }

    function pinchGeometry(touches) {
        const [a, b] = touches;
        return {
            dist: Math.hypot(a.x - b.x, a.y - b.y),
            midX: (a.x + b.x) / 2,
            midY: (a.y + b.y) / 2,
        };
    }

    function anchorPinch(touches) {
        const g = pinchGeometry(touches);
        pinchDist = g.dist;
        pinchMidX = g.midX;
        pinchMidY = g.midY;
    }

    function enterPinch(touches) {
        clearLiftTimer();
        if (touchState === "pinch") {
            anchorPinch(touches); // extra finger: just re-anchor
            return;
        }
        if (touchState === "pan") emit("onPanEnd", { pointerType: "touch" });
        if (touchState === "lifted") emit("onLiftCancel");
        touchState = "pinch";
        anchorPinch(touches);
        emit("onPinchStart");
    }

    function touchStart(evt) {
        const t = evt.touches;
        if (t.length >= 2) {
            enterPinch(t);
        } else if (t.length === 1) {
            touchState = "pending";
            startX = lastX = t[0].x;
            startY = lastY = t[0].y;
            startTime = evt.time ?? 0;
            armLiftTimer();
        }
    }

    function touchMove(evt) {
        const t = evt.touches;
        if (touchState === "pinch") {
            if (t.length < 2) return;
            const g = pinchGeometry(t);
            emit("onPinch", {
                scale: pinchDist > 0 ? g.dist / pinchDist : 1,
                dx: g.midX - pinchMidX,
                dy: g.midY - pinchMidY,
                centerX: g.midX,
                centerY: g.midY,
            });
            pinchDist = g.dist;
            pinchMidX = g.midX;
            pinchMidY = g.midY;
            return;
        }
        if (t.length !== 1 || touchState === "idle") return;
        const { x, y } = t[0];
        if (
            touchState === "pending" &&
            Math.hypot(x - startX, y - startY) > tapSlopPx
        ) {
            clearLiftTimer();
            touchState = "pan";
            emit("onPanStart", { pointerType: "touch" });
        }
        if (touchState === "pan") {
            emit("onPan", { dx: x - lastX, dy: y - lastY, pointerType: "touch" });
        } else if (touchState === "lifted") {
            emit("onLiftDrag", { x, y, dx: x - lastX, dy: y - lastY });
        }
        lastX = x;
        lastY = y;
    }

    function touchEnd(evt) {
        const t = evt.touches;
        if (t.length > 0) {
            // Fingers remain: only a pinch can hold more than one finger.
            if (touchState === "pinch") {
                if (t.length === 1) {
                    emit("onPinchEnd");
                    touchState = "pan";
                    lastX = t[0].x;
                    lastY = t[0].y;
                    emit("onPanStart", { pointerType: "touch" });
                } else {
                    anchorPinch(t);
                }
            }
            return;
        }
        clearLiftTimer();
        const endedState = touchState;
        touchState = "idle";
        if (endedState === "pending") {
            if ((evt.time ?? 0) - startTime <= tapMaxMs) {
                emit("onTap", { x: lastX, y: lastY });
            }
        } else if (endedState === "pan") {
            emit("onPanEnd", { pointerType: "touch" });
        } else if (endedState === "lifted") {
            emit("onLiftDrop", { x: lastX, y: lastY });
        } else if (endedState === "pinch") {
            emit("onPinchEnd");
        }
    }

    function touchCancel() {
        clearLiftTimer();
        touchState = "idle";
        emit("onCancel");
    }

    function mouseDown(evt) {
        mouseLastX = evt.x;
        mouseLastY = evt.y;
        if (evt.button === 1 || evt.button === 2) {
            mousePanning = true;
            emit("onPanStart", { pointerType: "mouse" });
        } else if (evt.button === 0) {
            leftDown = true;
            emit("onPress", { x: evt.x, y: evt.y });
        }
    }

    function mouseMove(evt) {
        const dx = evt.x - mouseLastX;
        const dy = evt.y - mouseLastY;
        if (leftDown) {
            emit("onDrag", { x: evt.x, y: evt.y, dx, dy });
        } else if (mousePanning) {
            emit("onPan", { dx, dy, pointerType: "mouse" });
        } else {
            emit("onHover", { x: evt.x, y: evt.y });
        }
        mouseLastX = evt.x;
        mouseLastY = evt.y;
    }

    function mouseUp(evt) {
        if (evt.button === 1 || evt.button === 2) {
            mousePanning = false;
            emit("onPanEnd", { pointerType: "mouse" });
        }
        if (evt.button === 0) leftDown = false;
        // Any button-up releases: the game finalizes an in-flight node drag on
        // every raw mouseup, whatever the button (frozen desktop baseline).
        emit("onRelease", { x: evt.x, y: evt.y });
    }

    return {
        handle(evt) {
            switch (evt.type) {
                case "touch-start":
                    touchStart(evt);
                    break;
                case "touch-move":
                    touchMove(evt);
                    break;
                case "touch-end":
                    touchEnd(evt);
                    break;
                case "touch-cancel":
                    touchCancel();
                    break;
                case "mouse-down":
                    mouseDown(evt);
                    break;
                case "mouse-move":
                    mouseMove(evt);
                    break;
                case "mouse-up":
                    mouseUp(evt);
                    break;
                case "mouse-leave":
                    emit("onHoverEnd");
                    break;
                case "wheel":
                    emit("onZoom", { deltaY: evt.deltaY, x: evt.x, y: evt.y });
                    break;
            }
        },
    };
}
