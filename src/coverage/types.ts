// Shared coverage shapes used across the coverage parsers, the server, and the
// client. Deliberately format-agnostic: Cobertura, LCOV and JaCoCo all reduce to
// "for this source file, these line numbers are executable and this many hits
// each", which is everything the UI needs.

// Which report dialect a file was parsed as. Surfaced in the UI so a user can
// tell at a glance which collector produced the numbers.
export type CoverageFormat = "cobertura" | "lcov" | "jacoco";

// Executable lines only: a line absent from this map is not executable (a
// comment, a blank line, a brace) and is rendered dim rather than red.
//   line number (1-based) -> times executed (0 = uncovered)
export type LineHits = Record<number, number>;

// Branch totals for one file. Not every report carries them, so both the field
// and its consumers stay optional.
export interface BranchTotals {
    covered: number;
    total: number;
}

export interface CoverageFile {
    // Path exactly as the report spelled it, kept for display and for pairing a
    // report entry back to a git diff entry.
    path: string;
    // Absolute on-disk path, once resolved (see sources.ts). Undefined when the
    // file could not be located -- e.g. a report generated on CI and read here.
    absPath?: string;
    lines: LineHits;
    coveredLines: number;
    totalLines: number;
    branches?: BranchTotals;
}

export interface CoverageTotals {
    files: number;
    coveredLines: number;
    totalLines: number;
    // Rounded percentage, or null when there is nothing executable to cover.
    percent: number | null;
    branches?: BranchTotals;
}

export interface CoverageReport {
    format: CoverageFormat;
    files: CoverageFile[];
    totals: CoverageTotals;
    // Source roots the report declared (Cobertura <sources>), used to turn its
    // relative paths into absolute ones.
    sourceRoots: string[];
}

// Percentage helper shared by the parsers, the patch calculation and the client
// so one rounding rule applies everywhere.
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

// Merge duplicate entries for the same path -- LCOV appends one record per test
// file, and Cobertura lists a partial class once per part -- by summing hits per
// line, then build the finished file list in first-seen order.
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
