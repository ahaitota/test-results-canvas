import type { CoverageReport } from "../model/types.js";
export declare function findProjectRoot(start: string): string;
interface ResolverOptions {
    sourceRoots?: readonly string[];
    projectRoot?: string;
}
export declare function resolveReportSources(report: CoverageReport, options?: ResolverOptions): CoverageReport;
export {};
