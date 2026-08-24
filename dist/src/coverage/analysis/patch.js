// Patch coverage: how much of the code that just changed is actually tested —
// "the agent wrote new code, did it write tests too?". A project-wide
// percentage can't answer that, since 40 new untested lines barely move it.
//
// Pure: git access lives in gitdiff.ts and file loading in the server.
import { percentOf } from "../model/totals.js";
import { isSamePathOrSuffix, normalizeSlashes } from "../sources/paths.js";
import { isProductionSource } from "../sources/classify.js";
// Paths are compared case-insensitively: Windows and macOS filesystems are, and
// the tool that wrote the report can disagree with git about capitalisation.
function key(p) {
    return normalizeSlashes(p).toLowerCase();
}
// Find the report entry for a changed file. An absolute-path match is exact;
// otherwise one spelling has to contain the whole of the other, which is what
// lines git's `src/app/calc.ts` up with LCOV's
// `/home/runner/work/repo/src/app/calc.ts`. The most specific spelling wins.
export function matchCoverageFile(change, files) {
    const wantedAbs = key(change.absPath);
    for (const f of files) {
        if (f.absPath && key(f.absPath) === wantedAbs)
            return f;
    }
    let best;
    let bestLength = 0;
    for (const f of files) {
        const matches = [change.path, change.absPath].some((c) => [f.path, f.absPath].some((t) => t && isSamePathOrSuffix(c, t)));
        if (!matches)
            continue;
        const length = normalizeSlashes(f.path).length;
        if (length > bestLength) {
            bestLength = length;
            best = f;
        }
    }
    return best;
}
// Cross the changed lines with the coverage report, per file and overall.
export function computePatchCoverage(report, changes, options = {}) {
    if (!changes)
        return null;
    const includeUnmeasured = options.includeUnmeasured !== false;
    const reportFiles = report?.files ?? [];
    const files = [];
    let covered = 0;
    let total = 0;
    let unmeasuredFiles = 0;
    for (const change of changes.files) {
        // Only production code: a changed README or a new test file says
        // nothing useful about coverage.
        if (!isProductionSource(change.path))
            continue;
        const match = matchCoverageFile(change, reportFiles);
        if (!match) {
            unmeasuredFiles++;
            if (includeUnmeasured) {
                files.push({
                    path: change.path,
                    absPath: change.absPath,
                    coveredLines: [],
                    uncoveredLines: [],
                    percent: null,
                    unmeasured: true,
                    // Untracked files carry their length instead of a diff.
                    changedLines: change.lineCount ?? change.lines.size,
                });
            }
            continue;
        }
        const coveredLines = [];
        const uncoveredLines = [];
        for (const [rawLine, hits] of Object.entries(match.lines)) {
            const line = Number(rawLine);
            // `all` marks a brand-new file, where every executable line is new.
            if (!change.all && !change.lines.has(line))
                continue;
            if (hits > 0)
                coveredLines.push(line);
            else
                uncoveredLines.push(line);
        }
        // A changed file whose changed lines are all non-executable — a comment
        // or a reformat — has nothing to report.
        if (!coveredLines.length && !uncoveredLines.length)
            continue;
        coveredLines.sort((a, b) => a - b);
        uncoveredLines.sort((a, b) => a - b);
        covered += coveredLines.length;
        total += coveredLines.length + uncoveredLines.length;
        files.push({
            path: match.path,
            absPath: match.absPath,
            coveredLines,
            uncoveredLines,
            percent: percentOf(coveredLines.length, coveredLines.length + uncoveredLines.length),
            unmeasured: false,
            changedLines: change.lineCount ?? change.lines.size,
        });
    }
    if (!files.length)
        return null;
    // Worst first. Unmeasured files lead, biggest first: with no coverage
    // numbers, size is all they have.
    files.sort((a, b) => {
        if (a.unmeasured !== b.unmeasured)
            return a.unmeasured ? -1 : 1;
        if (a.unmeasured)
            return b.changedLines - a.changedLines || a.path.localeCompare(b.path);
        if (b.uncoveredLines.length !== a.uncoveredLines.length)
            return b.uncoveredLines.length - a.uncoveredLines.length;
        return a.path.localeCompare(b.path);
    });
    return { against: changes.against, files, covered, total, percent: percentOf(covered, total), unmeasuredFiles };
}
// Group line numbers into runs, so the UI can say "lines 40-58" instead of
// listing nineteen numbers.
export function toRanges(lines) {
    const sorted = [...lines].sort((a, b) => a - b);
    const ranges = [];
    for (const line of sorted) {
        const last = ranges[ranges.length - 1];
        // A one-line gap is allowed, so a closing brace between two uncovered
        // statements doesn't split the run.
        if (last && line - last.end <= 2)
            last.end = line;
        else
            ranges.push({ start: line, end: line });
    }
    return ranges;
}
//# sourceMappingURL=patch.js.map