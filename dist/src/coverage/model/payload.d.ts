import type { CoverageFormat, CoverageTotals } from "./types.js";
export interface CoverageFileSummary {
    path: string;
    coveredLines: number;
    totalLines: number;
    percent: number | null;
    hasSource: boolean;
    changed: boolean;
    isTest: boolean;
}
export interface PatchFile {
    path: string;
    absPath?: string;
    coveredLines: number[];
    uncoveredLines: number[];
    unknownLines: number;
    percent: number | null;
    unmeasured: boolean;
    changedLines: number;
}
export interface PatchCoverage {
    against: string;
    files: PatchFile[];
    covered: number;
    total: number;
    percent: number | null;
    unmeasuredFiles: number;
    unknownLines: number;
}
export interface UncoveredRegion {
    path: string;
    absPath?: string;
    start: number;
    end: number;
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
    productionPercent: number | null;
    productionTotals: {
        coveredLines: number;
        totalLines: number;
        files: number;
    };
    patch: PatchCoverage | null;
    hotspots: UncoveredRegion[];
    revision?: number;
}
export interface SourceLine {
    n: number;
    text: string;
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
export interface CoverageSuggestion {
    ecosystem: string;
    command: string;
    outputHint: string;
    alternative?: Omit<CoverageSuggestion, "alternative">;
}
export type CoverageLoadFailure = "missing" | "unreadable" | "too-large" | "not-coverage";
