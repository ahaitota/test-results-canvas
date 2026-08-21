// Ranks uncovered code by how much it looks worth testing. A raw list of
// uncovered lines is unusable, so runs of lines are scored on signals we can
// read without understanding the language: whether the file was just changed
// (much the strongest), how long the run is, whether the file is entirely
// uncovered, and whether it is production code at all.
//
// Pure and host-free, so it also runs in the browser bundle.
import { toRanges } from "./patch.js";
import { isProductionSource } from "../sources/classify.js";
import { commonSuffixSegments, normalizeSlashes } from "../sources/paths.js";
// A single uncovered line is usually a guard clause or a `throw` — worth
// showing, but not ahead of a twenty-line untested function.
const SINGLE_LINE_WEIGHT = 0.4;
// Applied within the changed group, so a large new gap outranks a small one.
const CHANGED_WEIGHT = 4;
const WHOLE_FILE_WEIGHT = 1.6;
const DEFAULT_LIMIT = 25;
// Whether this file is one of the ones the diff touched.
function isChanged(file, changedPaths) {
    if (!changedPaths.length)
        return false;
    const abs = file.absPath ? normalizeSlashes(file.absPath).toLowerCase() : "";
    for (const changed of changedPaths) {
        const lower = normalizeSlashes(changed).toLowerCase();
        if (abs && (lower === abs || abs.endsWith(`/${lower}`)))
            return true;
        if (commonSuffixSegments(file.path, changed) > 1)
            return true;
    }
    return false;
}
// The uncovered runs most worth testing, best first.
export function rankUncovered(report, options = {}) {
    if (!report)
        return [];
    const changedPaths = options.changedPaths ?? [];
    const limit = options.limit ?? DEFAULT_LIMIT;
    const regions = [];
    for (const file of report.files) {
        if (!isProductionSource(file.path))
            continue;
        const uncovered = Object.entries(file.lines)
            .filter(([, hits]) => hits === 0)
            .map(([line]) => Number(line));
        if (!uncovered.length)
            continue;
        const changed = isChanged(file, changedPaths);
        const wholeFileUncovered = file.coveredLines === 0 && file.totalLines > 0;
        for (const range of toRanges(uncovered)) {
            const count = uncovered.filter((l) => l >= range.start && l <= range.end).length;
            let score = count === 1 ? SINGLE_LINE_WEIGHT : count;
            if (changed)
                score *= CHANGED_WEIGHT;
            if (wholeFileUncovered)
                score *= WHOLE_FILE_WEIGHT;
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
        if (a.changed !== b.changed)
            return a.changed ? -1 : 1;
        return b.score - a.score || a.path.localeCompare(b.path) || a.start - b.start;
    });
    return regions.slice(0, limit);
}
//# sourceMappingURL=rank.js.map