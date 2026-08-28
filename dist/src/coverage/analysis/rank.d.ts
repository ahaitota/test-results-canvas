import { type PathIdentity } from "../sources/paths.js";
import type { CoverageReport } from "../model/types.js";
import type { UncoveredRegion } from "../model/payload.js";
export type { UncoveredRegion } from "../model/payload.js";
export interface RankOptions {
    changedPaths?: readonly PathIdentity[];
    limit?: number;
}
export declare function rankUncovered(report: CoverageReport | null, options?: RankOptions): UncoveredRegion[];
