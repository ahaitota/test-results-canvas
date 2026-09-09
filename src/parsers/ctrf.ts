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
    let failed = 0;
    for (const entry of results.tests) {
        const t = rec(entry);
        const name = str(t, "name");
        const outcome = str(t, "status");
        // Identity and status are required by the schema: a record without them
        // would contribute no row, turning a failure into a shorter green run.
        if (!t || !name || !outcome || !STATUS.has(outcome.toLowerCase())) {
            throw new SyntaxError("ctrf test is missing its name or a known status");
        }
        if (outcome.toLowerCase() === "failed") failed++;
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
    // The report counts itself, so a mismatch means rows went missing between
    // the runner writing the summary and this file being read -- and a summary
    // claiming failures none of its tests admit to is the same disagreement
    // pointing the other way.
    const summary = rec(results.summary);
    const declared = num(summary, "tests");
    if (declared != null && declared !== out.length) {
        throw new SyntaxError(`ctrf summary declared ${declared} tests, found ${out.length}`);
    }
    const declaredFailed = num(summary, "failed");
    if (declaredFailed != null && declaredFailed !== failed) {
        throw new SyntaxError(`ctrf summary declared ${declaredFailed} failures, found ${failed}`);
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
