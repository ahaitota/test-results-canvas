import type { BranchTotals, CoverageFile, CoverageTotals, LineHits } from "./types.js";
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
