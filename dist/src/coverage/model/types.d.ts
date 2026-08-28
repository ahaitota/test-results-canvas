export type CoverageFormat = "cobertura" | "lcov" | "jacoco";
export type LineHits = Record<number, number>;
export interface BranchTotals {
    covered: number;
    total: number;
}
export interface CoverageFile {
    path: string;
    absPath?: string;
    lines: LineHits;
    coveredLines: number;
    totalLines: number;
    branches?: BranchTotals;
}
export interface CoverageTotals {
    files: number;
    coveredLines: number;
    totalLines: number;
    percent: number | null;
    branches?: BranchTotals;
}
export interface CoverageReport {
    format: CoverageFormat;
    files: CoverageFile[];
    totals: CoverageTotals;
    sourceRoots: string[];
}
