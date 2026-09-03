// CTRF JSON (https://ctrf.io): one schema many runners emit via a reporter —
// { results: { tool, summary, tests: [{ name, status, duration, ... }] } }.
import { rec, str, num, arr, joinMessage } from "./json.js";
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
    return ms == null ? undefined : new Date(ms).toISOString();
}
export function parseCtrf(text) {
    const results = rec(rec(JSON.parse(text))?.results);
    const tool = str(rec(results?.tool), "name");
    const out = [];
    for (const entry of arr(results, "tests")) {
        const t = rec(entry);
        const name = str(t, "name");
        if (!name)
            continue;
        out.push({
            name,
            status: status(str(t, "status")),
            durationMs: num(t, "duration"),
            message: joinMessage(str(t, "message"), str(t, "trace")),
            suite: str(t, "suite"),
            file: str(t, "filePath"),
            framework: tool,
            startTime: iso(num(t, "start")),
            endTime: iso(num(t, "stop")),
        });
    }
    return out;
}
//# sourceMappingURL=ctrf.js.map