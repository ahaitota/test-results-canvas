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
export declare function percentOf(covered: number, total: number): number | null;
export declare function tallyLines(lines: LineHits): {
    coveredLines: number;
    totalLines: number;
};
export declare function totalsOf(files: readonly CoverageFile[]): CoverageTotals;
export declare function buildFiles(raw: readonly {
    path: string;
    lines: LineHits;
    branches?: BranchTotals;
}[]): CoverageFile[];
