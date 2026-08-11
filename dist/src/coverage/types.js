// Shared coverage shapes used across the coverage parsers, the server, and the
// client. Deliberately format-agnostic: Cobertura, LCOV and JaCoCo all reduce to
// "for this source file, these line numbers are executable and this many hits
// each", which is everything the UI needs.
// Percentage helper shared by the parsers, the patch calculation and the client
// so one rounding rule applies everywhere.
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
// Merge duplicate entries for the same path -- LCOV appends one record per test
// file, and Cobertura lists a partial class once per part -- by summing hits per
// line, then build the finished file list in first-seen order.
export function buildFiles(raw) {
    const merged = new Map();
    for (const entry of raw) {
        const existing = merged.get(entry.path);
        if (!existing) {
            merged.set(entry.path, {
                path: entry.path,
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
//# sourceMappingURL=types.js.map