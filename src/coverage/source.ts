// Source text for one covered file, annotated line by line. Each line carries
// its hit count (null = not executable, rendered dim rather than red) and
// whether the current diff touched it.
//
// Security: the caller passes the path as spelled in the coverage report, and
// that string is looked up in the loaded report's own file list, so the absolute
// path served is always one the report produced. Traversal is impossible by
// construction rather than by filtering.

import { readFileSync, statSync } from "node:fs";
import { normalizeSlashes } from "./sources.js";
import { percentOf } from "./types.js";
import type { SourceLine, SourceFileView } from "./payload.js";
import type { LoadedCoverage } from "./load.js";

export type { SourceLine, SourceFileView } from "./payload.js";

export type SourceError = "unknown-file" | "no-source" | "unreadable";

// A source file far past this is not something anyone reads in a side panel,
// and the response has to stay small enough to render.
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_LINES = 20000;

// Find the report entry for a path exactly as the report spelled it, tolerating
// separator and case differences introduced in transit.
function findEntry(loaded: LoadedCoverage, path: string) {
    const wanted = normalizeSlashes(path).toLowerCase();
    return loaded.report.files.find((f) => normalizeSlashes(f.path).toLowerCase() === wanted);
}

export function readSourceView(loaded: LoadedCoverage, path: string): SourceFileView | SourceError {
    const entry = findEntry(loaded, path);
    if (!entry) return "unknown-file";
    if (!entry.absPath) return "no-source";

    let text: string;
    try {
        const st = statSync(entry.absPath);
        if (!st.isFile() || st.size > MAX_SOURCE_BYTES) return "unreadable";
        text = readFileSync(entry.absPath, "utf8");
    } catch {
        return "unreadable";
    }

    const changes = loaded.changedByPath.get(normalizeSlashes(entry.absPath).toLowerCase());
    const raw = text.split(/\r?\n/);
    const truncated = raw.length > MAX_LINES;
    const shown = truncated ? raw.slice(0, MAX_LINES) : raw;

    let firstUncovered: number | null = null;
    const lines: SourceLine[] = shown.map((lineText, i) => {
        const n = i + 1;
        const hits = Object.prototype.hasOwnProperty.call(entry.lines, n) ? entry.lines[n] : null;
        if (hits === 0 && firstUncovered === null) firstUncovered = n;
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
