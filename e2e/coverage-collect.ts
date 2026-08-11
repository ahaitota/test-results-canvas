// Coverage of the browser half of the canvas.
//
// The unit tests measure src/ under Node, but the panel itself -- every file in
// src/client -- runs in a browser, so that Node run never loads it and the
// report never mentions it. Those files then read "not measured", which is
// indistinguishable on screen from code nothing tests, even though the e2e
// suite exercises them heavily. This closes that gap by taking V8's own
// coverage from the browser while the e2e specs drive it.
//
// Opt-in via COVERAGE=1: collecting costs time and is useless unless the bundle
// carries a source map. A plain `npm run test:e2e` is unaffected.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Raw V8 output lands here; a separate reporting step turns it into LCOV, so a
// crashed or filtered run still leaves whatever it managed to collect.
export const RAW_DIR = join(ROOT, "test-results", "v8-raw");
// Where the run's own bundle and map are kept. The shipped bundle is minified
// and is rebuilt as soon as the run ends, so the report cannot read it back
// from dist/ and expect it to match the offsets the browser reported against.
export const CLIENT_BUILD_DIR = join(ROOT, "test-results", "client-build");

export const coverageEnabled = process.env.COVERAGE === "1";

export function isClientBundle(url: string): boolean {
    return /\/client\.js(\?|$)/.test(url);
}

export interface RawEntry {
    url: string;
    functions?: unknown[];
}

// Keep only the canvas bundle, and only its ranges. The source and map are
// identical for all hundred specs, so storing them per spec would write tens of
// megabytes of the same text; the runner snapshots them once instead.
//
// The bundle is served fresh from an ephemeral port by every spec, so the same
// file arrives under a hundred different URLs. They have to collapse to one
// name or the report shows a hundred copies of the client, each covered by a
// single test.
export function selectClientEntries(entries: readonly RawEntry[]): RawEntry[] {
    const out: RawEntry[] = [];
    for (const entry of entries) {
        if (!isClientBundle(entry.url)) continue;
        if (!entry.functions?.length) continue;
        out.push({ url: "canvas://client.js", functions: entry.functions });
    }
    return out;
}

export function writeRawCoverage(entries: readonly RawEntry[]): void {
    const selected = selectClientEntries(entries);
    if (!selected.length) return;
    mkdirSync(RAW_DIR, { recursive: true });
    writeFileSync(join(RAW_DIR, `${randomUUID()}.json`), JSON.stringify(selected), "utf8");
}
