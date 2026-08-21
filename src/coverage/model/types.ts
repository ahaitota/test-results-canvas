// The coverage data model: the shapes every part of the feature agrees on.
// Types only — the maths that turns them into numbers lives in totals.ts, so
// this file reads as a plain description of the data.
//
// All three report formats reduce to the same thing: for each source file,
// which lines can run and how many times each one did.

// Which report format this was parsed from. Shown in the UI.
export type CoverageFormat = "cobertura" | "lcov" | "jacoco";

// Executable lines only, keyed by 1-based line number, valued by how many times
// the line ran (0 = never). A line missing from the map cannot run at all — a
// comment or a blank — and the UI dims it instead of marking it uncovered.
export type LineHits = Record<number, number>;

// Branch counts for one file. Not every report has them, so this is optional
// throughout.
export interface BranchTotals {
    covered: number;
    total: number;
}

export interface CoverageFile {
    // The path spelled exactly as the report wrote it.
    path: string;
    // Where the file actually is on this machine, once we find it (see
    // sources/resolve.ts). Missing when we can't — for example a report built
    // on CI and read here.
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
    // null when there is nothing executable to cover.
    percent: number | null;
    branches?: BranchTotals;
}

export interface CoverageReport {
    format: CoverageFormat;
    files: CoverageFile[];
    totals: CoverageTotals;
    // Folders the report named as its source roots, used to turn its relative
    // paths into real ones.
    sourceRoots: string[];
}
