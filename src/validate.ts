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

// The optional file/folder seeds from a canvas open input; `input` itself is
// optional, since opening with no input is legal.
export function asOpenInput(input: { [k: string]: unknown } | undefined): {
    resultsFile?: string;
    resultsDir?: string;
    coverageFile?: string;
    coverageDir?: string;
    projectRoot?: string;
} {
    return {
        resultsFile: asString(input?.resultsFile),
        resultsDir: asString(input?.resultsDir),
        coverageFile: asString(input?.coverageFile),
        coverageDir: asString(input?.coverageDir),
        projectRoot: asString(input?.projectRoot),
    };
}
