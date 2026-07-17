// Layering contract (ADR-0002, issue #7). These are dependency rules, not
// behavior tests: they read the source tree and prove that
//   A. the simulation core has zero direct references to the DOM,
//      localStorage, Web Audio, Three.js or any other platform API;
//   B. the simulation core imports nothing outside src/sim + src/config.js;
//   C. localStorage lives only in the storage adapter;
//   D. Web Audio / <audio> element construction lives only in the audio
//      adapter;
//   E. raw input event sources (mouse/touch/key/wheel on the canvas,
//      window or document) are subscribed only inside the platform layer.
// Known limitation: the patterns are line-based with `//` and `/* */`
// comments stripped — they catch real call sites, not clever aliasing.
// That is the point of a guardrail: it fails loudly on the ordinary way
// of breaking the contract.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function listJsFiles(dir) {
    const out = [];
    for (const entry of readdirSync(path.join(ROOT, dir))) {
        const rel = `${dir}/${entry}`;
        if (statSync(path.join(ROOT, rel)).isDirectory()) {
            out.push(...listJsFiles(rel));
        } else if (entry.endsWith(".js")) {
            out.push(rel);
        }
    }
    return out;
}

// All web-layer + sim sources. game.js is the legacy entangled file and is
// deliberately included: the adapters exist so IT stops touching platform
// APIs directly.
const ALL_SOURCES = ["game.js", ...listJsFiles("src")];
const SIM_SOURCES = ALL_SOURCES.filter(
    (f) => f.startsWith("src/sim/") && !f.endsWith(".test.js")
);

// Strip // and /* */ comments so prose mentions of forbidden names don't
// trip the rules. String literals are kept — the usage patterns below all
// require call/member punctuation that prose doesn't contain.
function stripComments(source) {
    let out = "";
    let inBlock = false;
    for (const line of source.split("\n")) {
        let rest = line;
        let kept = "";
        while (rest.length > 0) {
            if (inBlock) {
                const end = rest.indexOf("*/");
                if (end === -1) { rest = ""; break; }
                rest = rest.slice(end + 2);
                inBlock = false;
            } else {
                const lineC = rest.indexOf("//");
                const blockC = rest.indexOf("/*");
                if (blockC !== -1 && (lineC === -1 || blockC < lineC)) {
                    kept += rest.slice(0, blockC);
                    rest = rest.slice(blockC + 2);
                    inBlock = true;
                } else if (lineC !== -1) {
                    kept += rest.slice(0, lineC);
                    rest = "";
                } else {
                    kept += rest;
                    rest = "";
                }
            }
        }
        out += kept + "\n";
    }
    return out;
}

// Whole-file matching (\s spans newlines) so a call split across lines —
// container.addEventListener(\n  "touchstart", … — is still caught.
function findViolations(files, patterns, { except = [] } = {}) {
    const violations = [];
    for (const file of files) {
        if (except.includes(file)) continue;
        const stripped = stripComments(
            readFileSync(path.join(ROOT, file), "utf8")
        );
        for (const pattern of patterns) {
            const re = new RegExp(pattern.source, "g");
            for (const match of stripped.matchAll(re)) {
                const line = stripped.slice(0, match.index).split("\n").length;
                violations.push(
                    `${file}:${line}: ${match[0].replace(/\s+/g, " ").trim()}`
                );
            }
        }
    }
    return violations;
}

describe("layering contract (ADR-0002)", () => {
    it("A. simulation core references no platform API", () => {
        expect(
            findViolations(SIM_SOURCES, [
                /\bwindow\s*[.[]/,
                /\bdocument\s*[.[]/,
                /\b(localStorage|sessionStorage)\s*[.[]/,
                /\bTHREE\b/,
                /\bnew\s+Audio\b/,
                /\bAudioContext\b/,
                /\bnavigator\s*[.[]/,
                /\baddEventListener\b/,
                /\b(requestAnimationFrame|cancelAnimationFrame)\b/,
                /\b(setTimeout|setInterval)\s*\(/,
                /\bperformance\s*[.[]/,
                /\bMath\.random\b/,
                /\balert\s*\(/,
                /\bfetch\s*\(/,
                /\bXMLHttpRequest\b/,
            ])
        ).toEqual([]);
    });

    it("B. simulation core imports only src/sim + src/config.js", () => {
        const violations = [];
        for (const file of SIM_SOURCES) {
            const source = stripComments(readFileSync(path.join(ROOT, file), "utf8"));
            for (const match of source.matchAll(
                /^\s*import\b[^;]*?from\s*["']([^"']+)["']/gm
            )) {
                const spec = match[1];
                if (!spec.startsWith("./") && spec !== "../config.js") {
                    violations.push(`${file}: import "${spec}"`);
                }
            }
        }
        expect(violations).toEqual([]);
    });

    it("C. localStorage appears only in the storage adapter", () => {
        expect(
            findViolations(
                ALL_SOURCES,
                [/\b(localStorage|sessionStorage)\s*[.[]/],
                { except: ["src/platform/storage.js"] }
            )
        ).toEqual([]);
    });

    it("D. Web Audio appears only in the audio adapter", () => {
        expect(
            findViolations(
                ALL_SOURCES,
                [/\bnew\s+Audio\s*\(/, /\bAudioContext\b/],
                { except: ["src/platform/audio.js"] }
            )
        ).toEqual([]);
    });

    it("E. raw input event sources are subscribed only in the platform layer", () => {
        const rawChannels =
            "(?:mouse|touch|pointer|key|wheel|contextmenu|blur|resize)";
        // \s* spans newlines: catches the channel name on its own line too.
        expect(
            findViolations(
                ALL_SOURCES.filter((f) => !f.startsWith("src/platform/")),
                [
                    new RegExp(
                        `\\b(?:window|document|container|canvas)\\s*\\.\\s*addEventListener\\s*\\(\\s*["'\`]${rawChannels}`
                    ),
                ]
            )
        ).toEqual([]);
    });
});
