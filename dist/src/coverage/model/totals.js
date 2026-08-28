// The maths over the coverage model. Kept apart from types.ts so that file
// stays a plain description of the data.
//
// Every percentage in the product comes from percentOf, so the file list, the
// header, patch coverage and the client all round the same way.
import { normalizeSlashes } from "../sources/paths.js";
// Rounded percentage, or null when there is nothing to cover. Null rather than
// 0 because "no executable lines" and "nothing ran" mean opposite things, and
// the UI colours them differently.
export function percentOf(covered, total) {
    if (!total)
        return null;
    return Math.round((covered / total) * 100);
}
// Count a file's executable/covered lines from its hit map.
export function tallyLines(lines) {
    let coveredLines = 0;
    let totalLines = 0;
    for (const hits of Object.values(lines)) {
        totalLines++;
        if (hits > 0)
            coveredLines++;
    }
    return { coveredLines, totalLines };
}
// Roll per-file numbers up into the report totals.
export function totalsOf(files) {
    let coveredLines = 0;
    let totalLines = 0;
    let branchCovered = 0;
    let branchTotal = 0;
    let anyBranches = false;
    for (const f of files) {
        coveredLines += f.coveredLines;
        totalLines += f.totalLines;
        if (f.branches) {
            anyBranches = true;
            branchCovered += f.branches.covered;
            branchTotal += f.branches.total;
        }
    }
    return {
        files: files.length,
        coveredLines,
        totalLines,
        percent: percentOf(coveredLines, totalLines),
        branches: anyBranches ? { covered: branchCovered, total: branchTotal } : undefined,
    };
}
// Some reports list the same file more than once -- LCOV appends a record per
// test file, Cobertura lists a partial class once per part. Sum the hits per
// line so each file appears once, in the order it was first seen.
//
// Separators are normalized here rather than downstream because this is where
// identity is decided: a Windows runner can write both "src\calc.ts" and
// "src/calc.ts" for one file, and merging on the raw spelling would leave it as
// two entries whose lines are counted twice and which patch matching can only
// call ambiguous.
export function buildFiles(raw) {
    const merged = new Map();
    for (const entry of raw) {
        const path = normalizeSlashes(entry.path);
        const existing = merged.get(path);
        if (!existing) {
            merged.set(path, {
                path,
                lines: { ...entry.lines },
                branches: entry.branches ? { ...entry.branches } : undefined,
            });
            continue;
        }
        for (const [line, hits] of Object.entries(entry.lines)) {
            const n = Number(line);
            existing.lines[n] = (existing.lines[n] ?? 0) + hits;
        }
        if (entry.branches) {
            existing.branches = existing.branches
                ? { covered: existing.branches.covered + entry.branches.covered, total: existing.branches.total + entry.branches.total }
                : { ...entry.branches };
        }
    }
    return [...merged.values()].map((entry) => ({
        path: entry.path,
        lines: entry.lines,
        ...tallyLines(entry.lines),
        branches: entry.branches,
    }));
}
//# sourceMappingURL=totals.js.map