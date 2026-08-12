import type { CoverageReport } from "./types.js";
export declare function normalizeSlashes(p: string): string;
export declare function findProjectRoot(start: string): string;
export declare function commonSuffixSegments(a: string, b: string): number;
interface ResolverOptions {
    sourceRoots?: readonly string[];
    projectRoot?: string;
}
export declare function resolveReportSources(report: CoverageReport, options?: ResolverOptions): CoverageReport;
export {};
