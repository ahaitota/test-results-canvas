// The coverage wire contract: every shape that crosses from the server to the
// browser. It is separate because the modules that produce these shapes import
// node:fs and node:path, which the client bundle must not pull in even for types.

import type { CoverageFormat, CoverageTotals } from "./types.js";

// One row in the coverage file list. Per-line hits stay on the server and
// arrive with the file's text when a row is expanded, so opening the panel on a
// large solution costs one small message.
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
    // Path as the coverage report spells it when measured, otherwise the
    // repo-relative path git reported.
    path: string;
    absPath?: string;
    coveredLines: number[];
    uncoveredLines: number[];
    percent: number | null;
    // A changed file with no coverage data at all.
    unmeasured: boolean;
    // What git says changed, before coverage has any say. This is the only size
    // an unmeasured file has: without it a 200-line new module reads the same as
    // a one-line edit. 0 for a new file git reported without line detail.
    changedLines: number;
}

// "Did the code that just changed get tested?" -- issue #28, point 2.
export interface PatchCoverage {
    // What was compared, e.g. "uncommitted changes".
    against: string;
    files: PatchFile[];
    covered: number;
    total: number;
    percent: number | null;
    unmeasuredFiles: number;
}

// A contiguous run of uncovered lines, scored by how much it matters --
// issue #28, point 3.
export interface UncoveredRegion {
    path: string;
    absPath?: string;
    start: number;
    end: number;
    // Uncovered lines inside the region; its span can be larger, since a
    // one-line gap does not split a run.
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
    // Production-only coverage, which is the number users mean by "what is our
    // coverage?". Its own totals travel with it so the header never puts a
    // production percentage over a fraction that includes test code.
    productionPercent: number | null;
    productionTotals: { coveredLines: number; totalLines: number; files: number };
    patch: PatchCoverage | null;
    hotspots: UncoveredRegion[];
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
