// CTRF JSON (https://ctrf.io): one schema many runners emit via a reporter —
// { results: { tool, summary, tests: [{ name, status, duration, ... }] } }.
import { rec, str, num, joinMessage, isoFromEpoch } from "./json.js";
// The statuses the CTRF schema defines; a record outside them is not a result
// this report can be read without.
const STATUS = new Set(["passed", "failed", "skipped", "pending", "other"]);
function status(raw) {
    const s = String(raw || "").toLowerCase();
    if (s === "passed")
        return "pass";
    if (s === "failed")
        return "fail";
    return "skip";
}
function iso(ms) {
    // CTRF timestamps are epoch milliseconds.
    return isoFromEpoch(ms);
}
export function parseCtrf(text) {
    const results = rec(rec(JSON.parse(text))?.results);
    // Something in the document already claimed this as CTRF, so a missing
    // `results` object or `tests` array is a malformed report -- not a run in
    // which nothing happened. An explicitly empty array still is one.
    if (!results || !Array.isArray(results.tests)) {
        throw new SyntaxError("ctrf report has no results.tests array");
    }
    const tool = str(rec(results.tool), "name");
    const out = [];
    for (const entry of results.tests) {
        const t = rec(entry);
        const name = str(t, "name");
        const outcome = str(t, "status");
        // Identity and status are required by the schema: a record without them
        // would contribute no row, turning a failure into a shorter green run.
        if (!t || !name || !outcome || !STATUS.has(outcome.toLowerCase())) {
            throw new SyntaxError("ctrf test is missing its name or a known status");
        }
        out.push({
            name,
            status: status(outcome),
            durationMs: num(t, "duration"),
            message: joinMessage(str(t, "message"), str(t, "trace")),
            suite: str(t, "suite"),
            file: str(t, "filePath"),
            framework: tool,
            startTime: iso(num(t, "start")),
            endTime: iso(num(t, "stop")),
        });
    }
    // The report counts itself, so a mismatch means rows went missing between
    // the runner writing the summary and this file being read.
    const declared = num(rec(results.summary), "tests");
    if (declared != null && declared !== out.length) {
        throw new SyntaxError(`ctrf summary declared ${declared} tests, found ${out.length}`);
    }
    return out;
}
//# sourceMappingURL=ctrf.js.map