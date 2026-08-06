import type { CoverageReport } from "./types.js";
export declare function normalizeSlashes(p: string): string;
export declare function findProjectRoot(start: string): string;
export declare function commonSuffixSegments(a: string, b: string): number;
export interface ResolverOptions {
    sourceRoots?: readonly string[];
    projectRoot?: string;
}
export interface SourceResolver {
    projectRoot?: string;
    resolve(reportPath: string): string | undefined;
}
export declare function createSourceResolver(options?: ResolverOptions): SourceResolver;
export declare function resolveReportSources(report: CoverageReport, options?: ResolverOptions): CoverageReport;
