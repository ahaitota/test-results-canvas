// The coverage wire contract: every shape that crosses from the server to the
// browser, and nothing else.
//
// It lives in its own module because the client bundle must stay host-free --
// the modules that *produce* these shapes all reach for `node:fs`, `node:path`
// or `child_process`, so the client cannot import from them even for types
// without dragging Node's typings into a config that deliberately has none.
// Declaring the contract once here, and having both sides import it, keeps the
// two ends from drifting apart the way a hand-copied mirror would.

import type { CoverageFormat, CoverageTotals } from "./types.js";

// One row in the coverage file list. Per-line hits are deliberately absent:
// they stay on the server and arrive with the file's text when a row is
// expanded, so opening the panel on a large solution costs one small message.
export interface CoverageFileSummary {
    path: string;
    coveredLines: number;
    totalLines: number;
    percent: number | null;
    // The file was located on disk, so its source can be shown.
    hasSource: boolean;
    // Touched by the change set being compared.
    changed: boolean;
    // Test code, shown but de-emphasised.
    isTest: boolean;
}

// Coverage of one changed file.
export interface PatchFile {
    // Path as the coverage report spells it when the file was measured,
    // otherwise the repo-relative path git reported.
    path: string;
    absPath?: string;
    // Changed lines that are executable, split by whether they ran.
    coveredLines: number[];
    uncoveredLines: number[];
    percent: number | null;
    // A changed source file with no coverage data at all -- the strongest signal
    // that new code arrived with no test touching it.
    unmeasured: boolean;
}

// "Did the code that just changed get tested?" -- issue #28, point 2.
export interface PatchCoverage {
    // What was compared, e.g. "uncommitted changes".
    against: string;
    files: PatchFile[];
    covered: number;
    total: number;
    percent: number | null;
    // Changed production files the report never mentions.
    unmeasuredFiles: number;
}

// A contiguous run of uncovered lines, scored by how much it matters --
// issue #28, point 3.
export interface UncoveredRegion {
    path: string;
    absPath?: string;
    start: number;
    end: number;
    // Uncovered executable lines inside the region (its span can be larger,
    // since a one-line gap does not split a run).
    lines: number;
    // The file was touched by the change set currently being compared.
    changed: boolean;
    // Nothing in the file is covered at all.
    wholeFileUncovered: boolean;
    score: number;
}

// What the client receives over SSE.
export interface CoveragePayload {
    // Display label for the report file.
    file: string;
    format: CoverageFormat;
    totals: CoverageTotals;
    files: CoverageFileSummary[];
    // Coverage restricted to production code, which is the number users mean
    // when they ask "what is our coverage?". The totals it was computed from
    // travel with it: showing this percentage above the whole-report fraction
    // would put a production number over a figure that includes test code.
    productionPercent: number | null;
    productionTotals: { coveredLines: number; totalLines: number; files: number };
    patch: PatchCoverage | null;
    hotspots: UncoveredRegion[];
}

// One line of an expanded file, as served by /source.
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
    // First uncovered line, so the client can scroll straight to it.
    firstUncovered: number | null;
}

// How to make a run produce coverage, for the empty state.
export interface CoverageSuggestion {
    // Short ecosystem label, e.g. ".NET".
    ecosystem: string;
    // The command to re-run the tests with coverage enabled.
    command: string;
    // Where the report will land, so the wording can promise something concrete.
    outputHint: string;
}
