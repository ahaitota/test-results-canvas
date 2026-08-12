import type { CoverageFormat, CoverageReport } from "./types.js";
export declare function detectCoverageFormat(content: unknown): CoverageFormat | null;
export declare function looksLikeCoverage(content: unknown): boolean;
export declare function parseCoverage(content: string): CoverageReport | null;
export declare function nameScore(fileName: string): number;
export declare function hasCoverageExt(fileName: string): boolean;
