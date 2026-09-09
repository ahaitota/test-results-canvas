// CTRF JSON (https://ctrf.io): one schema many runners emit via a reporter —
// { results: { tool, summary, tests: [{ name, status, duration, ... }] } }.

import type { TestResult, TestStatus } from "../types.js";
import { rec, str, num, joinMessage, isoFromEpoch } from "./json.js";
import type { Rec } from "./json.js";

// The statuses the CTRF schema defines; a record outside them is not a result
// this report can be read without.
const STATUS = new Set(["passed", "failed", "skipped", "pending", "other"]);

function status(raw: string | undefined): TestStatus {
    const s = String(raw || "").toLowerCase();
    if (s === "passed") return "pass";
    if (s === "failed") return "fail";
    return "skip";
}

function iso(ms: number | undefined): string | undefined {
    // CTRF timestamps are epoch milliseconds.
    return isoFromEpoch(ms);
}


export function parseCtrf(text: string): TestResult[] {
    const results = rec(rec(JSON.parse(text))?.results);
    // Something in the document already claimed this as CTRF, so a missing
    // `results` object or `tests` array is a malformed report -- not a run in
    // which nothing happened. An explicitly empty array still is one.
    if (!results || !Array.isArray(results.tests)) {
        throw new SyntaxError("ctrf report has no results.tests array");
    }
    const tool = str(rec(results.tool), "name");
    const out: TestResult[] = [];
    // Counted under CTRF's own status names rather than the three this panel
    // shows: pending and other both render as "skip", so tallying the rendered
    // status could not tell one counter from the other.
    const found = new Map<string, number>();
    for (const entry of results.tests) {
        const t = rec(entry);
        const name = str(t, "name");
        const outcome = str(t, "status");
        // Identity and status are required by the schema: a record without them
        // would contribute no row, turning a failure into a shorter green run.
        if (!t || !name || !outcome || !STATUS.has(outcome.toLowerCase())) {
            throw new SyntaxError("ctrf test is missing its name or a known status");
        }
        const key = outcome.toLowerCase();
        found.set(key, (found.get(key) ?? 0) + 1);
        out.push({
            name,
            status: status(outcome),
            durationMs: num(t, "duration"),
            message: joinMessage(str(t, "message"), str(t, "trace")),
            // A suite is a string in the original shape and a path of them in
            // the current one.
            suite: suiteOf(t),
            file: str(t, "filePath"),
            framework: tool,
            startTime: iso(num(t, "start")),
            endTime: iso(num(t, "stop")),
        });
    }
    // The schema requires the summary and every one of its counters. A count
    // that disagrees means rows went missing between the runner writing it and
    // this file being read -- or that a failure has been replaced by a pass,
    // which a total on its own would not notice. One that is absent or is not a
    // number leaves nothing to check the tests against at all.
    const summary = rec(results.summary);
    if (!summary) {
        throw new SyntaxError("ctrf report has no results.summary");
    }
    const declared = num(summary, "tests");
    if (declared == null) {
        throw new SyntaxError("ctrf summary has no numeric test count");
    }
    if (declared !== out.length) {
        throw new SyntaxError(`ctrf summary declared ${declared} tests, found ${out.length}`);
    }
    for (const name of STATUS) {
        const count = num(summary, name);
        if (count == null) {
            throw new SyntaxError(`ctrf summary has no numeric ${name} count`);
        }
        if (count !== (found.get(name) ?? 0)) {
            throw new SyntaxError(`ctrf summary declared ${count} ${name}, found ${found.get(name) ?? 0}`);
        }
    }
    return out;
}

// CTRF 1.0 carries the suite as an array of names from the root down; the
// original shape used a single string.
function suiteOf(t: Rec): string | undefined {
    const raw = t.suite;
    if (Array.isArray(raw)) {
        const path = raw.filter((s): s is string => typeof s === "string" && s !== "");
        return path.length ? path.join(" > ") : undefined;
    }
    return str(t, "suite");
}
