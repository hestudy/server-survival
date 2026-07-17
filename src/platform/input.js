// Platform adapter: input event source (ADR-0002, issue #7). Raw input —
// pointer, touch, wheel, keyboard, focus loss, viewport resize — enters the
// game only through this adapter, so the mini-game port replaces it with
// wx.onTouchStart et al. without touching the handlers. Listeners on UI
// elements (buttons, panels, indicators) are a UI-layer concern and stay
// with the DOM they own.

// Page-level channels attach to the window; everything else is anchored to
// the rendering surface.
const GLOBAL_CHANNELS = new Set(["keydown", "keyup", "blur", "resize"]);

export function createWebInputSource(canvas) {
    return {
        on(channel, handler, options) {
            const target = GLOBAL_CHANNELS.has(channel) ? window : canvas;
            target.addEventListener(channel, handler, options);
        },

        // Replay a synthetic mouse event into the same pipeline — used by
        // the M0 touch prototype's tap replay and the live tooltip refresh.
        replayMouse(channel, x, y) {
            canvas.dispatchEvent(
                new MouseEvent(channel, {
                    bubbles: true,
                    cancelable: true,
                    clientX: x,
                    clientY: y,
                    button: 0,
                })
            );
        },
    };
}
