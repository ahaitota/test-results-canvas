export interface CoverageCandidate {
    path: string;
    mtimeMs: number;
    score: number;
}
export declare function findCoverageFiles(root: string, opts?: {
    maxDepth?: number;
}): CoverageCandidate[];
export declare function pickBest(candidates: readonly CoverageCandidate[]): string | null;
export declare function newestCoverageFileIn(dir: string): string | null;
export declare function discoverCoverageFor(resultsFile: string, projectRoot?: string): string | null;
