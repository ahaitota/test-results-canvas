// Ranks uncovered code by how much it looks worth testing. A raw list of
// uncovered lines is unusable, so runs of lines are scored on signals we can
// read without understanding the language: whether the file was just changed
// (much the strongest), how long the run is, whether the file is entirely
// uncovered, and whether it is production code at all.
//
// Pure and host-free, so it also runs in the browser bundle.

import { toRanges } from "./patch.js";
import { isProductionSource } from "../sources/classify.js";
import { isSamePathOrSuffix } from "../sources/paths.js";
import type { CoverageFile, CoverageReport } from "../model/types.js";
import type { UncoveredRegion } from "../model/payload.js";

export type { UncoveredRegion } from "../model/payload.js";

// A single uncovered line is usually a guard clause or a `throw` — worth
// showing, but not ahead of a twenty-line untested function.
const SINGLE_LINE_WEIGHT = 0.4;
// Applied within the changed group, so a large new gap outranks a small one.
const CHANGED_WEIGHT = 4;
const WHOLE_FILE_WEIGHT = 1.6;

const DEFAULT_LIMIT = 25;

// Whether this file is one of the ones the diff touched. One spelling has to
// contain the whole of the other: sibling packages share their trailing folders
// without being the same file.
function isChanged(file: CoverageFile, changedPaths: readonly string[]): boolean {
    for (const changed of changedPaths) {
        if (file.absPath && isSamePathOrSuffix(file.absPath, changed)) return true;
        if (isSamePathOrSuffix(file.path, changed)) return true;
    }
    return false;
}

export interface RankOptions {
    // Paths (repo-relative or absolute) touched by the current diff.
    changedPaths?: readonly string[];
    limit?: number;
}

// The uncovered runs most worth testing, best first.
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

    // Changed code is its own group, not just a bigger score. A multiplier
    // can't express "always look at what you just touched first" — a four-times
    // bonus still loses to an untouched block four times longer. Sorting in two
    // groups keeps that promise and makes the order easy to explain.
    regions.sort((a, b) => {
        if (a.changed !== b.changed) return a.changed ? -1 : 1;
        return b.score - a.score || a.path.localeCompare(b.path) || a.start - b.start;
    });
    return regions.slice(0, limit);
}
