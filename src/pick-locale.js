// System-language detection (issue #13, spec story 19): map the browser's
// preferred language tags onto a supported locale. An exact tag match wins
// (pt-BR), then a primary-subtag match (zh-Hans-CN → zh); candidates are
// tried in preference order. Pure — no navigator/storage access — so it is
// testable headless; i18n.js feeds it navigator.languages.
export function pickLocale(candidates, supported, fallback = "en") {
    for (const tag of candidates || []) {
        if (!tag) continue;
        const lower = String(tag).toLowerCase();
        const exact = supported.find((l) => l.toLowerCase() === lower);
        if (exact) return exact;
        const primary = lower.split("-")[0];
        const partial = supported.find(
            (l) => l.toLowerCase().split("-")[0] === primary
        );
        if (partial) return partial;
    }
    return fallback;
}
