// Patch coverage: how much of the code that just changed is actually tested.
// A project-wide percentage cannot answer that, since 40 new untested lines
// barely move it. Pure: git lives in gitdiff.ts, file loading in the server.
import { percentOf } from "../model/totals.js";
import { matchPath } from "../sources/paths.js";
import { isProductionSource } from "../sources/classify.js";
// An entry is only taken when no other entry could be meant.
export function matchCoverageFile(change, files) {
    return matchPath(change, files, (f) => f);
}
// Changed lines the report has no entry for, minus the ones the source proves
// inert. What remains is real code the report skipped.
function countUnknown(changed, lines, inert) {
    let n = 0;
    for (const line of changed) {
        if (Object.prototype.hasOwnProperty.call(lines, line))
            continue;
        if (inert?.has(line))
            continue;
        n++;
    }
    return n;
}
// A whole-file change has no line set to compare against, so a stale report
// shows up as length: the file runs past the last line the report mentions, and
// those lines were never measured. Treating every unmentioned line that way
// instead would count the braces and declarations that executable-line reports
// such as coverlet and JaCoCo never list. An unscanned source proves nothing,
// so it claims nothing.
function countUnknownTail(lineCount, lines, inert) {
    if (lineCount === undefined || !inert)
        return 0;
    let last = 0;
    for (const key of Object.keys(lines)) {
        const line = Number(key);
        if (line > last)
            last = line;
    }
    let n = 0;
    for (let line = last + 1; line <= lineCount; line++)
        if (!inert.has(line))
            n++;
    return n;
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
    let unknown = 0;
    let unmeasuredFiles = 0;
    // Only production code: a changed README or a new test file says nothing
    // useful about coverage.
    const production = changes.files.filter((c) => isProductionSource(c.path));
    // Matched up front, because an entry is only that file's when no other
    // change can claim it too: a report path shortened to src/index.ts ends
    // both packages/a/src/index.ts and packages/b/src/index.ts.
    const matched = new Map();
    const claims = new Map();
    for (const change of production) {
        const found = matchCoverageFile(change, reportFiles);
        matched.set(change, found);
        if (found)
            claims.set(found, (claims.get(found) ?? 0) + 1);
    }
    for (const change of production) {
        const found = matched.get(change);
        const match = found && claims.get(found) === 1 ? found : undefined;
        if (!match) {
            unmeasuredFiles++;
            if (includeUnmeasured) {
                files.push({
                    path: change.path,
                    absPath: change.absPath,
                    coveredLines: [],
                    uncoveredLines: [],
                    unknownLines: 0,
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
        // `all` covers the whole file, so staleness is measured by length
        // rather than by a line set.
        const inert = match.absPath ? options.inertLines?.get(match.absPath) : undefined;
        const unknownLines = change.all
            ? countUnknownTail(change.lineCount, match.lines, inert)
            : countUnknown(change.lines, match.lines, inert);
        // Nothing here the report can speak to either way.
        if (!coveredLines.length && !uncoveredLines.length && !unknownLines)
            continue;
        coveredLines.sort((a, b) => a - b);
        uncoveredLines.sort((a, b) => a - b);
        covered += coveredLines.length;
        total += coveredLines.length + uncoveredLines.length;
        unknown += unknownLines;
        files.push({
            path: match.path,
            absPath: match.absPath,
            coveredLines,
            uncoveredLines,
            unknownLines,
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
    return { against: changes.against, files, covered, total, percent: percentOf(covered, total), unmeasuredFiles, unknownLines: unknown };
}
// Group line numbers into runs, so the UI can say "lines 40-58".
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