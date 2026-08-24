// Ranks uncovered code by how much it looks worth testing. Runs of lines are
// scored on signals we can read without understanding the language: whether the
// file was just changed (much the strongest), how long the run is, whether the
// file is entirely uncovered, and whether it is production code at all.
//
// Pure and host-free, so it also runs in the browser bundle.

import { toRanges } from "./patch.js";
import { isProductionSource } from "../sources/classify.js";
import { matchPath, type PathIdentity } from "../sources/paths.js";
import type { CoverageFile, CoverageReport } from "../model/types.js";
import type { UncoveredRegion } from "../model/payload.js";

export type { UncoveredRegion } from "../model/payload.js";

// A single uncovered line is usually a guard clause or a `throw`.
const SINGLE_LINE_WEIGHT = 0.4;
// Applied within the changed group, so a large new gap outranks a small one.
const CHANGED_WEIGHT = 4;
const WHOLE_FILE_WEIGHT = 1.6;

const DEFAULT_LIMIT = 25;

// Which report entries the diff touched. Resolved from the changed file
// outwards, the same direction patch.ts uses: asking each entry "did anything
// change that looks like me?" answers yes for both src/Calc.ts and src/calc.ts.
function changedFiles(files: readonly CoverageFile[], changed: readonly PathIdentity[]): Set<CoverageFile> {
    const found = new Set<CoverageFile>();
    for (const one of changed) {
        const match = matchPath(one, files, (f) => f);
        if (match) found.add(match);
    }
    return found;
}

export interface RankOptions {
    // The files the current diff touched. Resolved paths travel with the
    // spellings so an entry belonging to another package is not ranked changed.
    changedPaths?: readonly PathIdentity[];
    limit?: number;
}

export function rankUncovered(report: CoverageReport | null, options: RankOptions = {}): UncoveredRegion[] {
    if (!report) return [];
    const changedPaths = options.changedPaths ?? [];
    const limit = options.limit ?? DEFAULT_LIMIT;
    const changed = changedFiles(report.files, changedPaths);
    const regions: UncoveredRegion[] = [];

    for (const file of report.files) {
        if (!isProductionSource(file.path)) continue;
        const uncovered = Object.entries(file.lines)
            .filter(([, hits]) => hits === 0)
            .map(([line]) => Number(line));
        if (!uncovered.length) continue;

        const isChanged = changed.has(file);
        const wholeFileUncovered = file.coveredLines === 0 && file.totalLines > 0;

        for (const range of toRanges(uncovered)) {
            const count = uncovered.filter((l) => l >= range.start && l <= range.end).length;
            let score = count === 1 ? SINGLE_LINE_WEIGHT : count;
            if (isChanged) score *= CHANGED_WEIGHT;
            if (wholeFileUncovered) score *= WHOLE_FILE_WEIGHT;
            regions.push({
                path: file.path,
                absPath: file.absPath,
                start: range.start,
                end: range.end,
                lines: count,
                changed: isChanged,
                wholeFileUncovered,
                score: Math.round(score * 100) / 100,
            });
        }
    }

    // Changed code is its own group, not just a bigger score. A multiplier
    // cannot express "always look at what you just touched first" -- a
    // four-times bonus still loses to an untouched block four times longer.
    regions.sort((a, b) => {
        if (a.changed !== b.changed) return a.changed ? -1 : 1;
        return b.score - a.score || a.path.localeCompare(b.path) || a.start - b.start;
    });
    return regions.slice(0, limit);
}
