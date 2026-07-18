// Platform adapter: system language (ADR-0002, issue #13). `navigator` is a
// browser API, so reading the device's preferred languages lives here — the
// mini-game port swaps this for wx.getSystemInfoSync().language without
// touching i18n or the pure pickLocale mapping.
export function systemLanguages() {
    if (typeof navigator === "undefined") return [];
    if (navigator.languages && navigator.languages.length) return navigator.languages;
    return navigator.language ? [navigator.language] : [];
}
