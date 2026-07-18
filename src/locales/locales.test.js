// i18n key alignment check (issue #13, M3-d): the nine locales must expose
// identical key sets, and every key the UI can ask for — statically via
// data-i18n attributes / t("...") literals, or dynamically via known key
// families (service ids, "_desc" suffixes, upkeep levels, traffic types,
// smart hints) — must exist in every locale. A key missing anywhere leaks the
// raw key name (or untranslated English) into that language's UI.
//
// Locale files are classic scripts sharing one global scope (see
// src/main.js), so they are evaluated here with a stub `window` instead of
// being imported.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const localesDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(localesDir, "..", "..");

const LOCALE_FILES = {
    en: "en.js",
    zh: "zh.js",
    "pt-BR": "pt-BR.js",
    de: "de.js",
    fr: "fr.js",
    ko: "ko.js",
    ru: "ru.js",
    it: "it.js",
    ne: "nep.js",
};

function loadLocale(file) {
    const src = readFileSync(join(localesDir, file), "utf8");
    const globalName = src.match(/const (\w+_TRANSLATIONS)/)[1];
    return new Function("window", `${src}; return ${globalName};`)({});
}

const locales = Object.fromEntries(
    Object.entries(LOCALE_FILES).map(([code, file]) => [code, loadLocale(file)])
);
const enKeys = new Set(Object.keys(locales.en));

it("covers every locale file in this directory", () => {
    const files = readdirSync(localesDir).filter(
        (f) => f.endsWith(".js") && !f.endsWith(".test.js")
    );
    expect(files.sort()).toEqual(Object.values(LOCALE_FILES).sort());
});

describe("key sets are identical across the nine locales", () => {
    for (const code of Object.keys(LOCALE_FILES)) {
        if (code === "en") continue;
        it(`${code} matches en`, () => {
            const keys = new Set(Object.keys(locales[code]));
            const missing = [...enKeys].filter((k) => !keys.has(k));
            const extra = [...keys].filter((k) => !enKeys.has(k));
            expect({ missing, extra }).toEqual({ missing: [], extra: [] });
        });
    }
});

// Every key the UI references must be defined (in en — the previous block
// already forces the other eight to match en exactly).
describe("every referenced key is defined in every locale", () => {
    const sources = ["index.html", "game.js"]
        .concat(
            readdirSync(join(rootDir, "src"), { recursive: true })
                .filter((f) => f.endsWith(".js") && !f.includes("locales"))
                .map((f) => join("src", f))
        )
        .map((f) => [f, readFileSync(join(rootDir, f), "utf8")]);

    it("static keys: data-i18n attributes and t(\"...\") literals", () => {
        const used = new Set();
        for (const [, src] of sources) {
            for (const m of src.matchAll(
                /data-i18n(?:-title)?=(?:\\?["']|&quot;)([\w-]+)/g
            )) {
                used.add(m[1]);
            }
            // t("key") / i18n.t('key') — lookbehind keeps identifiers ending
            // in t (split, parseInt, …) from matching.
            for (const m of src.matchAll(
                /(?<![\w$.])(?:i18n\.)?t\(\s*["'`]([\w-]+)["'`]\s*[,)]/g
            )) {
                used.add(m[1]);
            }
        }
        expect(used.size).toBeGreaterThan(200);
        const missing = [...used].filter((k) => !enKeys.has(k));
        expect(missing).toEqual([]);
    });

    it("dynamic key families: services, upkeep levels, traffic types, hints", () => {
        const config = readFileSync(join(rootDir, "src", "config.js"), "utf8");
        const game = readFileSync(join(rootDir, "game.js"), "utf8");
        const used = new Set();

        // t(s.type) and t(s.type + "_desc") — service ids are the keys of
        // CONFIG.services, recognizable by their tooltip blocks.
        const serviceIds = [
            ...config.matchAll(
                /^\s{4}(\w+): \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*name: "[^"]*",\s*\n\s*cost:/gm
            ),
        ].map((m) => m[1]);
        expect(serviceIds.length).toBeGreaterThanOrEqual(13);
        for (const id of serviceIds) {
            used.add(id);
            used.add(`${id}_desc`);
        }

        // t(config.tooltip.upkeep.toLowerCase())
        for (const m of config.matchAll(/upkeep:\s*"([^"]+)"/g)) {
            used.add(m[1].toLowerCase());
        }

        // t("traffic_" + type.toLowerCase())
        for (const m of config.matchAll(/^\s{2}(\w+): "\1",$/gm)) {
            used.add(`traffic_${m[1].toLowerCase()}`);
        }

        // Smart hints: t(hint.key)
        const hintKeys = [...game.matchAll(/hint = \{ key: "(\w+)"/g)].map(
            (m) => m[1]
        );
        expect(hintKeys.length).toBeGreaterThanOrEqual(7);
        for (const k of hintKeys) used.add(k);

        const missing = [...used].filter((k) => !enKeys.has(k));
        expect(missing).toEqual([]);
    });
});

describe("interpolation placeholders match en", () => {
    const placeholders = (text) =>
        [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

    for (const code of Object.keys(LOCALE_FILES)) {
        if (code === "en") continue;
        it(`${code} keeps every {variable}`, () => {
            const mismatches = [];
            for (const [key, enText] of Object.entries(locales.en)) {
                if (!(key in locales[code])) continue;
                const want = placeholders(enText).join(",");
                const got = placeholders(locales[code][key]).join(",");
                if (want !== got) mismatches.push({ key, want, got });
            }
            expect(mismatches).toEqual([]);
        });
    }
});
