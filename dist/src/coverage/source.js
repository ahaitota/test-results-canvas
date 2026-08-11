// Source text for one covered file, annotated line by line.
//
// Percentages tell you there is a problem; this is what tells you where. Each
// line comes back with its hit count (null = not executable, so it renders dim
// rather than red) and whether the current diff touched it.
//
// Security: the caller passes the path *as spelled in the coverage report*, and
// that string is looked up in the loaded report's own file list. The absolute
// path served is therefore always one the report itself produced -- never
// anything derived from the request -- so path traversal is impossible by
// construction rather than by filtering, the same rule resolveResultPath()
// already applies to results files.
import { readFileSync, statSync } from "node:fs";
import { normalizeSlashes } from "./sources.js";
import { percentOf } from "./types.js";
// A source file far past this is not something anyone reads in a side panel,
// and the response has to stay small enough to render.
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_LINES = 20000;
// Find the report entry for a path exactly as the report spelled it, tolerating
// separator and case differences introduced in transit.
function findEntry(loaded, path) {
    const wanted = normalizeSlashes(path).toLowerCase();
    return loaded.report.files.find((f) => normalizeSlashes(f.path).toLowerCase() === wanted);
}
export function readSourceView(loaded, path) {
    const entry = findEntry(loaded, path);
    if (!entry)
        return "unknown-file";
    if (!entry.absPath)
        return "no-source";
    let text;
    try {
        const st = statSync(entry.absPath);
        if (!st.isFile() || st.size > MAX_SOURCE_BYTES)
            return "unreadable";
        text = readFileSync(entry.absPath, "utf8");
    }
    catch {
        return "unreadable";
    }
    const changes = loaded.changedByPath.get(normalizeSlashes(entry.absPath).toLowerCase());
    const raw = text.split(/\r?\n/);
    const truncated = raw.length > MAX_LINES;
    const shown = truncated ? raw.slice(0, MAX_LINES) : raw;
    let firstUncovered = null;
    const lines = shown.map((lineText, i) => {
        const n = i + 1;
        const hits = Object.prototype.hasOwnProperty.call(entry.lines, n) ? entry.lines[n] : null;
        if (hits === 0 && firstUncovered === null)
            firstUncovered = n;
        return {
            n,
            text: lineText,
            hits,
            changed: Boolean(changes && (changes.all || changes.lines.has(n))),
        };
    });
    return {
        path: entry.path,
        lines,
        truncated,
        coveredLines: entry.coveredLines,
        totalLines: entry.totalLines,
        percent: percentOf(entry.coveredLines, entry.totalLines),
        firstUncovered,
    };
}
//# sourceMappingURL=source.js.map