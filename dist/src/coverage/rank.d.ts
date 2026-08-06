import type { CoverageReport } from "./types.js";
import type { UncoveredRegion } from "./payload.js";
export type { UncoveredRegion } from "./payload.js";
export interface RankOptions {
    changedPaths?: readonly string[];
    limit?: number;
}
export declare function rankUncovered(report: CoverageReport | null, options?: RankOptions): UncoveredRegion[];
