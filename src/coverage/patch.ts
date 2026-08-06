// Patch coverage: how much of the code that just changed is actually tested.
//
// This is the part of the feature that answers "the agent wrote new code -- did
// it also write tests for it?". A project-wide percentage cannot answer that,
// because 40 new untested lines barely move it. Intersecting the changed line
// numbers with the coverage hit map answers it exactly.
//
// Pure: git access happens in gitdiff.ts and file loading in the server, so the
// interesting logic here is unit-testable with plain objects.

import { percentOf } from "./types.js";
import type { CoverageFile, CoverageReport } from "./types.js";
import type { PatchFile, PatchCoverage } from "./payload.js";
import type { FileChanges } from "./gitdiff.js";
import { commonSuffixSegments, normalizeSlashes } from "./sources.js";
import { isProductionSource } from "./classify.js";

export type { PatchFile, PatchCoverage } from "./payload.js";

// Paths are compared case-insensitively: Windows and macOS filesystems are, and
// a report written by one tool can disagree with git about casing.
function key(p: string): string {
    return normalizeSlashes(p).toLowerCase();
}

// Pair a changed file with its entry in the coverage report. An absolute-path
// match is exact; otherwise the entry sharing the most trailing segments wins,
// which is what lines up git's `src/app/calc.ts` with LCOV's
// `/home/runner/work/repo/src/app/calc.ts`.
export function matchCoverageFile(change: FileChanges, files: readonly CoverageFile[]): CoverageFile | undefined {
    const wantedAbs = key(change.absPath);
    for (const f of files) {
        if (f.absPath && key(f.absPath) === wantedAbs) return f;
    }
    let best: CoverageFile | undefined;
    let bestScore = 1; // a shared filename alone is too weak
    for (const f of files) {
        const score = Math.max(
            commonSuffixSegments(change.path, f.path),
            f.absPath ? commonSuffixSegments(change.absPath, f.absPath) : 0,
        );
        if (score > bestScore) {
            bestScore = score;
            best = f;
        }
    }
    return best;
}

export interface PatchOptions {
    // Include changed files that carry no coverage data. On by default: an
    // untested new file is the single most useful thing to surface.
    includeUnmeasured?: boolean;
}

export function computePatchCoverage(
    report: CoverageReport | null,
    changes: { against: string; files: readonly FileChanges[] } | null,
    options: PatchOptions = {},
): PatchCoverage | null {
    if (!changes) return null;
    const includeUnmeasured = options.includeUnmeasured !== false;
    const reportFiles = report?.files ?? [];

    const files: PatchFile[] = [];
    let covered = 0;
    let total = 0;
    let unmeasuredFiles = 0;

    for (const change of changes.files) {
        // Only production code: a changed README or a new test file has nothing
        // meaningful to say about coverage.
        if (!isProductionSource(change.path)) continue;

        const match = matchCoverageFile(change, reportFiles);
        if (!match) {
            unmeasuredFiles++;
            if (includeUnmeasured) {
                files.push({ path: change.path, coveredLines: [], uncoveredLines: [], percent: null, unmeasured: true });
            }
            continue;
        }

        const coveredLines: number[] = [];
        const uncoveredLines: number[] = [];
        for (const [rawLine, hits] of Object.entries(match.lines)) {
            const line = Number(rawLine);
            // `all` marks a brand-new file, where every executable line is new.
            if (!change.all && !change.lines.has(line)) continue;
            if (hits > 0) coveredLines.push(line);
            else uncoveredLines.push(line);
        }
        // A changed file whose changed lines are all non-executable (a comment,
        // a reformat) has nothing to report.
        if (!coveredLines.length && !uncoveredLines.length) continue;

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
        });
    }

    if (!files.length) return null;

    // Worst first: the files needing attention lead the panel.
    files.sort((a, b) => {
        if (a.unmeasured !== b.unmeasured) return a.unmeasured ? -1 : 1;
        if (b.uncoveredLines.length !== a.uncoveredLines.length) return b.uncoveredLines.length - a.uncoveredLines.length;
        return a.path.localeCompare(b.path);
    });

    return { against: changes.against, files, covered, total, percent: percentOf(covered, total), unmeasuredFiles };
}

// Contiguous runs of uncovered lines, so the UI can say "lines 40-58" instead of
// listing nineteen numbers.
export function toRanges(lines: readonly number[]): { start: number; end: number }[] {
    const sorted = [...lines].sort((a, b) => a - b);
    const ranges: { start: number; end: number }[] = [];
    for (const line of sorted) {
        const last = ranges[ranges.length - 1];
        // Allow a one-line gap so a closing brace between two uncovered
        // statements doesn't split the run.
        if (last && line - last.end <= 2) last.end = line;
        else ranges.push({ start: line, end: line });
    }
    return ranges;
}
