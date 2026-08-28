// Narrows model-generated action/open input. The SDK validates it against the
// declared JSON schemas first, but the compiler only sees `unknown`.

import type { ResultInput } from "./server.js";

// A non-empty string, or undefined for anything else.
export function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

// A finite number, or undefined. NaN/Infinity would render as "NaNms".
export function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// One test result, or null. Only `name` is required; normalizeStatus() in the
// server already maps any unknown status onto pass/fail/skip.
export function asResultInput(value: unknown): ResultInput | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const name = asString(raw.name);
    if (!name) return null;
    return { name, status: raw.status, durationMs: asNumber(raw.durationMs), message: asString(raw.message) };
}

// The most paths a single open/action may name. A merged run is a handful of
// test projects, not a filesystem crawl; the cap keeps one bad argument from
// turning into thousands of stat calls.
export const MAX_SOURCE_PATHS = 64;

// Non-empty strings from an array, deduped and capped. Anything that is not an
// array yields an empty list. Duplicates are dropped here rather than after
// path resolution so the cap counts real files, not repeats of one.
export function asStringArray(value: unknown, max: number = MAX_SOURCE_PATHS): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        const s = asString(entry);
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
        if (out.length >= max) break;
    }
    return out;
}

// The optional file/folder seeds from a canvas open input; `input` itself is
// optional, since opening with no input is legal. `resultsFiles` is the merged
// form; the singular fields are the original one-file API and keep working.
export function asOpenInput(input: { [k: string]: unknown } | undefined): {
    name?: string;
    resultsFile?: string;
    resultsDir?: string;
    resultsFiles?: string[];
    coverageFile?: string;
    coverageDir?: string;
    projectRoot?: string;
} {
    const resultsFiles = asStringArray(input?.resultsFiles);
    return {
        name: asString(input?.name),
        resultsFile: asString(input?.resultsFile),
        resultsDir: asString(input?.resultsDir),
        // Absent rather than empty, so a caller can tell "no list given" from
        // "a list that held nothing usable".
        resultsFiles: resultsFiles.length ? resultsFiles : undefined,
        coverageFile: asString(input?.coverageFile),
        coverageDir: asString(input?.coverageDir),
        projectRoot: asString(input?.projectRoot),
    };
}

// Input to the `open_files` action.
export function asFilesInput(input: { [k: string]: unknown } | undefined): {
    name?: string;
    files: string[];
} {
    return { name: asString(input?.name), files: asStringArray(input?.files) };
}
