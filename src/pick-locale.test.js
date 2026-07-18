// System-language detection (issue #13, spec story 19): on first launch the
// UI follows the device language when it is one of the nine supported
// locales; an explicit picker choice (stored under game_locale) always wins
// over detection — that part lives in i18n.js, this seam covers the mapping.
import { describe, expect, it } from "vitest";
import { pickLocale } from "./pick-locale.js";

const SUPPORTED = ["en", "zh", "pt-BR", "de", "fr", "ko", "ru", "it", "ne"];

describe("pickLocale", () => {
    it("matches an exact tag regardless of case", () => {
        expect(pickLocale(["pt-br"], SUPPORTED)).toBe("pt-BR");
        expect(pickLocale(["ZH"], SUPPORTED)).toBe("zh");
    });

    it("falls back to the primary language subtag", () => {
        expect(pickLocale(["zh-Hans-CN"], SUPPORTED)).toBe("zh");
        expect(pickLocale(["de-AT"], SUPPORTED)).toBe("de");
        expect(pickLocale(["ne-NP"], SUPPORTED)).toBe("ne");
        expect(pickLocale(["pt-PT"], SUPPORTED)).toBe("pt-BR");
    });

    it("honors preference order across candidates", () => {
        expect(pickLocale(["da", "ko-KR", "en"], SUPPORTED)).toBe("ko");
    });

    it("returns the fallback when nothing matches", () => {
        expect(pickLocale(["da", "sv"], SUPPORTED)).toBe("en");
        expect(pickLocale([], SUPPORTED)).toBe("en");
        expect(pickLocale(undefined, SUPPORTED)).toBe("en");
        expect(pickLocale([null, ""], SUPPORTED)).toBe("en");
    });
});
