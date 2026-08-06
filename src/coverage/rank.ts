// Ranking uncovered code by how much it matters.
//
// A raw list of every uncovered line is unusable -- a mid-sized project has
// thousands. Issue #28 asks specifically for "the places which are not covered
// but are really important to cover", so this ranks contiguous uncovered regions
// instead of lines, using signals available without understanding the language:
//
//   * the file was just changed          -- by far the strongest signal
//   * the region is long                 -- a whole function or branch that has
//                                           never once executed
//   * the file is entirely uncovered     -- a module no test reaches at all
//   * the file is production code        -- tests and generated output excluded
//
// Pure and host-free, so it is unit-testable and can also run in the browser
// bundle.

import { toRanges } from "./patch.js";
import { isProductionSource } from "./classify.js";
import { commonSuffixSegments, normalizeSlashes } from "./sources.js";
import type { CoverageFile, CoverageReport } from "./types.js";
import type { UncoveredRegion } from "./payload.js";

export type { UncoveredRegion } from "./payload.js";

// A single uncovered line is usually a guard clause or a `throw`; worth showing,
// but not ahead of a twenty-line untested function.
const SINGLE_LINE_WEIGHT = 0.4;
// Applied within the changed tier, so a large new gap outranks a small one.
const CHANGED_WEIGHT = 4;
const WHOLE_FILE_WEIGHT = 1.6;

const DEFAULT_LIMIT = 25;

function isChanged(file: CoverageFile, changedPaths: readonly string[]): boolean {
    if (!changedPaths.length) return false;
    const abs = file.absPath ? normalizeSlashes(file.absPath).toLowerCase() : "";
    for (const changed of changedPaths) {
        const lower = normalizeSlashes(changed).toLowerCase();
        if (abs && (lower === abs || abs.endsWith(`/${lower}`))) return true;
        if (commonSuffixSegments(file.path, changed) > 1) return true;
    }
    return false;
}

export interface RankOptions {
    // Paths (repo-relative or absolute) touched by the current diff.
    changedPaths?: readonly string[];
    limit?: number;
}

export function rankUncovered(report: CoverageReport | null, options: RankOptions = {}): UncoveredRegion[] {
    if (!report) return [];
    const changedPaths = options.changedPaths ?? [];
    const limit = options.limit ?? DEFAULT_LIMIT;
    const regions: UncoveredRegion[] = [];

    for (const file of report.files) {
        if (!isProductionSource(file.path)) continue;
        const uncovered = Object.entries(file.lines)
            .filter(([, hits]) => hits === 0)
            .map(([line]) => Number(line));
        if (!uncovered.length) continue;

        const changed = isChanged(file, changedPaths);
        const wholeFileUncovered = file.coveredLines === 0 && file.totalLines > 0;

        for (const range of toRanges(uncovered)) {
            const count = uncovered.filter((l) => l >= range.start && l <= range.end).length;
            let score = count === 1 ? SINGLE_LINE_WEIGHT : count;
            if (changed) score *= CHANGED_WEIGHT;
            if (wholeFileUncovered) score *= WHOLE_FILE_WEIGHT;
            regions.push({
                path: file.path,
                absPath: file.absPath,
                start: range.start,
                end: range.end,
                lines: count,
                changed,
                wholeFileUncovered,
                score: Math.round(score * 100) / 100,
            });
        }
    }

    // Changed code is a *tier*, not a weight. A multiplier cannot express
    // "always look at what you just touched first": a four-times bonus still
    // loses to an untouched block four times longer, so a two-line gap in the
    // file being edited would sink below a dead module nobody is working on.
    // Sorting in two tiers keeps the section's promise -- and makes its order
    // explainable, which a tuned constant never is.
    regions.sort((a, b) => {
        if (a.changed !== b.changed) return a.changed ? -1 : 1;
        return b.score - a.score || a.path.localeCompare(b.path) || a.start - b.start;
    });
    return regions.slice(0, limit);
}
