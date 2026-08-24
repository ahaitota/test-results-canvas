// Reads one covered file's text back and annotates it line by line: how many
// times each line ran (null when it can't run, so the UI dims it) and whether
// the current diff touched it.
//
// Security: the caller passes a path as spelled in the coverage report, and we
// look that string up in the loaded report's own file list. The absolute path
// we then read is always one the report produced, so directory traversal isn't
// possible in the first place rather than being filtered out.
import { readFileSync, statSync } from "node:fs";
import { normalizeSlashes } from "./paths.js";
import { percentOf } from "../model/totals.js";
// Nobody reads a file bigger than this in a side panel, and the response has to
// stay small enough to render.
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_LINES = 20000;
// Find a report entry by path. Slash spelling is picked up in transit, so it is
// ignored; case is not, or two files whose names differ only in case would each
// open the other's source. A case-insensitive match is still allowed when only
// one entry can be meant by it.
function findEntry(loaded, path) {
    const wanted = normalizeSlashes(path);
    const exact = loaded.report.files.find((f) => normalizeSlashes(f.path) === wanted);
    if (exact)
        return exact;
    const lower = wanted.toLowerCase();
    const near = loaded.report.files.filter((f) => normalizeSlashes(f.path).toLowerCase() === lower);
    return near.length === 1 ? near[0] : undefined;
}
// The annotated source for one file, or a reason it can't be shown.
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
//# sourceMappingURL=view.js.map