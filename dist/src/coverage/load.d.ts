import type { DiffOptions, FileChanges } from "./gitdiff.js";
import type { CoverageReport } from "./types.js";
import type { CoveragePayload } from "./payload.js";
export type { CoverageFileSummary, CoveragePayload } from "./payload.js";
export interface LoadedCoverage {
    path: string;
    mtimeMs: number;
    report: CoverageReport;
    payload: CoveragePayload;
    projectRoot?: string;
    changedByPath: Map<string, FileChanges>;
}
export interface LoadOptions {
    projectRoot?: string;
    diff?: DiffOptions;
    skipGit?: boolean;
    keepNonExecutable?: boolean;
}
export declare function loadCoverageFile(coverageFile: string, options?: LoadOptions): LoadedCoverage | null;
