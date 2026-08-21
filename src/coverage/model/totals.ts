// The maths over the coverage model. Kept apart from types.ts so that file
// stays a plain description of the data.
//
// Every percentage in the product comes from percentOf, so the file list, the
// header, patch coverage and the client all round the same way.

import type { BranchTotals, CoverageFile, CoverageTotals, LineHits } from "./types.js";

// Rounded percentage, or null when there is nothing to cover. Null rather than
// 0 because "no executable lines" and "nothing ran" mean opposite things, and
// the UI colours them differently.
export function percentOf(covered: number, total: number): number | null {
    if (!total) return null;
    return Math.round((covered / total) * 100);
}

// Count a file's executable/covered lines from its hit map.
export function tallyLines(lines: LineHits): { coveredLines: number; totalLines: number } {
    let coveredLines = 0;
    let totalLines = 0;
    for (const hits of Object.values(lines)) {
        totalLines++;
        if (hits > 0) coveredLines++;
    }
    return { coveredLines, totalLines };
}

// Roll per-file numbers up into the report totals.
export function totalsOf(files: readonly CoverageFile[]): CoverageTotals {
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

// Some reports list the same file more than once — LCOV appends a record per
// test file, Cobertura lists a partial class once per part. Sum the hits per
// line so each file appears once, in the order it was first seen.
export function buildFiles(raw: readonly { path: string; lines: LineHits; branches?: BranchTotals }[]): CoverageFile[] {
    const merged = new Map<string, { path: string; lines: LineHits; branches?: BranchTotals }>();
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
