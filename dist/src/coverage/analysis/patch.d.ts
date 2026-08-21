import type { CoverageFile, CoverageReport } from "../model/types.js";
import type { PatchCoverage } from "../model/payload.js";
import type { FileChanges } from "./gitdiff.js";
export type { PatchFile, PatchCoverage } from "../model/payload.js";
export declare function matchCoverageFile(change: FileChanges, files: readonly CoverageFile[]): CoverageFile | undefined;
export interface PatchOptions {
    includeUnmeasured?: boolean;
}
export declare function computePatchCoverage(report: CoverageReport | null, changes: {
    against: string;
    files: readonly FileChanges[];
} | null, options?: PatchOptions): PatchCoverage | null;
export declare function toRanges(lines: readonly number[]): {
    start: number;
    end: number;
}[];
