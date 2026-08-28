// The wire contract: every shape that travels from the server to the browser.
// It is a file of its own because the modules that build these shapes import
// node:fs and node:path, and the client bundle must not pull those in -- not
// even for types.

import type { CoverageFormat, CoverageTotals } from "./types.js";

// One row in the coverage file list. Per-line hits stay on the server until a
// row is expanded, so opening the panel on a big solution costs one message.
export interface CoverageFileSummary {
    path: string;
    coveredLines: number;
    totalLines: number;
    percent: number | null;
    // The file was located on disk, so its source can be shown.
    hasSource: boolean;
    changed: boolean;
    isTest: boolean;
}

export interface PatchFile {
    // The report's spelling when the file was measured, otherwise the
    // repo-relative path git gave us.
    path: string;
    absPath?: string;
    coveredLines: number[];
    uncoveredLines: number[];
    // Changed lines the report has no entry for. Blank lines and braces land
    // here, but so does every line of a report taken before the edit, so a
    // percentage over the measured lines alone can be an overstatement.
    unknownLines: number;
    percent: number | null;
    // A changed file the report has no entry for at all.
    unmeasured: boolean;
    // How many lines git says changed. For an unmeasured file this is the only
    // sense of size we have.
    changedLines: number;
}

// How much of the code that just changed is tested.
export interface PatchCoverage {
    // What was compared, e.g. "uncommitted changes".
    against: string;
    files: PatchFile[];
    // Measured changed lines only: unknownLines is in neither, so `percent` is
    // coverage of what the report can speak to rather than of the change set.
    // Anything showing it has to say so whenever unknownLines is above zero.
    covered: number;
    total: number;
    percent: number | null;
    unmeasuredFiles: number;
    unknownLines: number;
}

// A run of uncovered lines, scored by how much it looks worth testing.
export interface UncoveredRegion {
    path: string;
    absPath?: string;
    start: number;
    end: number;
    // Uncovered lines inside the region. The span can be wider, because a
    // one-line gap doesn't split a run.
    lines: number;
    changed: boolean;
    wholeFileUncovered: boolean;
    score: number;
}

export interface CoveragePayload {
    file: string;
    format: CoverageFormat;
    totals: CoverageTotals;
    files: CoverageFileSummary[];
    // Coverage of production code only. Its totals travel with it so the header
    // never shows a production percentage over a fraction counting test code.
    productionPercent: number | null;
    productionTotals: { coveredLines: number; totalLines: number; files: number };
    patch: PatchCoverage | null;
    hotspots: UncoveredRegion[];
    // Changes on every read of the report, so views built from it can tell one
    // read from the next.
    revision?: number;
}

export interface SourceLine {
    n: number;
    text: string;
    // Execution count, 0 for uncovered, null when the line is not executable.
    hits: number | null;
    changed: boolean;
}

export interface SourceFileView {
    path: string;
    lines: SourceLine[];
    truncated: boolean;
    coveredLines: number;
    totalLines: number;
    percent: number | null;
    firstUncovered: number | null;
}

// How to make a run produce coverage, for the empty state.
export interface CoverageSuggestion {
    ecosystem: string;
    command: string;
    outputHint: string;
}

// Why a report could not be loaded. Sent to the panel so it can explain a file
// it found but could not use, rather than implying none was collected.
export type CoverageLoadFailure = "missing" | "unreadable" | "too-large" | "not-coverage";
