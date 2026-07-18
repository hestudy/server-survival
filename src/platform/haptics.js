// Platform adapter: haptic feedback (ADR-0002, issue #9). The lift (抬起)
// confirmation buzz reaches the hardware only through this adapter, so the
// mini-game port swaps in wx.vibrateShort without touching the gesture
// consumers. Devices without a vibration API (notably iOS Safari) silently
// no-op — the visual raise is the universal feedback channel.
export const haptics = {
    vibrate(ms) {
        if (
            typeof navigator !== "undefined" &&
            typeof navigator.vibrate === "function"
        ) {
            navigator.vibrate(ms);
        }
    },
};
