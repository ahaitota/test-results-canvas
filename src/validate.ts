// Validation for input that arrives from the agent.
//
// Canvas action and open inputs are model-generated. The SDK does validate them
// against the JSON schemas declared in extension.ts before a handler runs, so
// malformed input is normally rejected before it reaches us — but that
// guarantee lives in the schema, which is runtime data, not in the type system.
// The compiler only sees `input?: { [k: string]: unknown }`: optional, with
// every value unknown. Handlers therefore still have to narrow.
//
// These helpers are that narrowing, and they double as a safety net for the one
// case the schema can't cover: a schema and its handler drifting apart when
// someone edits one and forgets the other. They never throw — they return
// undefined/null so the caller can answer the agent with a clear message
// instead of taking down the extension host.

import type { ResultInput } from "./server.js";

// A non-empty string, or undefined for anything else.
export function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

// A finite number, or undefined. Rejects NaN/Infinity, which would render as
// "NaNms" in the UI and break duration totals.
export function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// One test result, or null if it can't be salvaged. `name` is the only hard
// requirement: `status` is passed through as-is because the server's
// normalizeStatus() already maps any unknown value onto pass/fail/skip.
export function asResultInput(value: unknown): ResultInput | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const name = asString(raw.name);
    if (!name) return null;
    return { name, status: raw.status, durationMs: asNumber(raw.durationMs), message: asString(raw.message) };
}

// The optional resultsFile/resultsDir seed from a canvas open input. Non-string
// values are dropped rather than passed on to existsSync()/path joins, so a bad
// input opens an empty canvas instead of throwing during open. `input` itself is
// optional: opening the canvas with no input at all is legal.
export function asOpenInput(input: { [k: string]: unknown } | undefined): { resultsFile?: string; resultsDir?: string } {
    return { resultsFile: asString(input?.resultsFile), resultsDir: asString(input?.resultsDir) };
}
