// Ties the coverage pieces together into the state the panel renders.
//
//   report file -> parse -> resolve real paths -> intersect with the git diff
//                        -> rank what is worth covering -> payload
//
// Only summaries go over SSE. Per-line hit maps stay on the server and are sent
// with the file's text when a row is expanded (see the /source route), so
// opening the panel on a large solution costs one small message rather than
// megabytes of line numbers the user may never look at.
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve as resolvePath } from "node:path";
import { parseCoverage } from "./detect.js";
import { resolveReportSources, findProjectRoot, normalizeSlashes } from "./sources.js";
import { changedLines } from "./gitdiff.js";
import { computePatchCoverage } from "./patch.js";
import { rankUncovered } from "./rank.js";
import { isProductionSource, isTestPath } from "./classify.js";
import { commentSyntaxFor, nonExecutableLines } from "./executable.js";
import { percentOf, tallyLines, totalsOf } from "./types.js";
// A coverage report for a very large solution is still only tens of MB; past
// this it is not something the panel can usefully render.
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
// Ceilings for the pass that re-reads sources to discard comment lines. A
// generated file can be enormous, and a report can name thousands of files, so
// the work is bounded: past the budget the report is left as the tool wrote it,
// which is the behaviour this pass improves on rather than depends on.
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_BYTES = 96 * 1024 * 1024;
// Drop lines the report calls coverable but the source shows to be comment or
// blank. Tools that already report only executable lines are unaffected: there
// is nothing for this to remove. Both the numerator and the denominator lose
// the line, since a "covered" comment is no more meaningful than an uncovered
// one -- the aim is a number that answers "how much of my code is tested", and
// prose is not code.
function dropNonExecutable(report) {
    let budget = MAX_SCAN_BYTES;
    let changed = false;
    const files = report.files.map((f) => {
        if (!f.absPath || budget <= 0)
            return f;
        const syntax = commentSyntaxFor(f.path);
        let text;
        try {
            const st = statSync(f.absPath);
            if (!st.isFile() || st.size > MAX_SOURCE_BYTES)
                return f;
            budget -= st.size;
            text = readFileSync(f.absPath, "utf8");
        }
        catch {
            // Unreadable source means no proof either way, so nothing is dropped.
            return f;
        }
        const inert = nonExecutableLines(text, syntax);
        if (inert.size === 0)
            return f;
        const lines = {};
        let dropped = 0;
        for (const [key, hits] of Object.entries(f.lines)) {
            const line = Number(key);
            if (inert.has(line)) {
                dropped++;
                continue;
            }
            lines[line] = hits;
        }
        if (dropped === 0)
            return f;
        changed = true;
        return { ...f, lines, ...tallyLines(lines) };
    });
    if (!changed)
        return report;
    return { ...report, files, totals: totalsOf(files) };
}
function summarize(files, changedPaths) {
    const changedKeys = changedPaths.map((p) => normalizeSlashes(p).toLowerCase());
    return files.map((f) => {
        const abs = f.absPath ? normalizeSlashes(f.absPath).toLowerCase() : "";
        const own = normalizeSlashes(f.path).toLowerCase();
        const changed = changedKeys.some((c) => c === abs || c === own || (abs && abs.endsWith(`/${c}`)) || own.endsWith(`/${c}`));
        return {
            path: f.path,
            coveredLines: f.coveredLines,
            totalLines: f.totalLines,
            percent: percentOf(f.coveredLines, f.totalLines),
            hasSource: Boolean(f.absPath),
            changed,
            isTest: isTestPath(f.path),
        };
    });
}
// Coverage counting production code only.
function productionOnly(files) {
    let coveredLines = 0;
    let totalLines = 0;
    let count = 0;
    for (const f of files) {
        if (!isProductionSource(f.path))
            continue;
        count++;
        coveredLines += f.coveredLines;
        totalLines += f.totalLines;
    }
    return { coveredLines, totalLines, files: count };
}
// Read and fully derive one coverage report. Returns null when the file is
// missing, too large, or not a coverage report at all.
export function loadCoverageFile(coverageFile, options = {}) {
    const abs = resolvePath(String(coverageFile || ""));
    let text;
    let mtimeMs;
    try {
        const st = statSync(abs);
        if (!st.isFile() || st.size > MAX_REPORT_BYTES)
            return null;
        mtimeMs = st.mtimeMs;
        text = readFileSync(abs, "utf8");
    }
    catch {
        return null;
    }
    const parsed = parseCoverage(text);
    if (!parsed)
        return null;
    const projectRoot = options.projectRoot ?? findProjectRoot(dirname(abs));
    const resolved = resolveReportSources(parsed, { projectRoot });
    const report = options.keepNonExecutable ? resolved : dropNonExecutable(resolved);
    let diff = null;
    if (!options.skipGit && projectRoot) {
        try {
            diff = changedLines(projectRoot, options.diff ?? {});
        }
        catch {
            diff = null;
        }
    }
    const changedPaths = diff ? diff.files.map((f) => f.path) : [];
    const patch = computePatchCoverage(report, diff);
    const hotspots = rankUncovered(report, { changedPaths });
    const changedByPath = new Map();
    for (const f of diff?.files ?? [])
        changedByPath.set(normalizeSlashes(f.absPath).toLowerCase(), f);
    const production = productionOnly(report.files);
    return {
        path: abs,
        mtimeMs,
        report,
        projectRoot,
        changedByPath,
        payload: {
            file: basename(abs),
            format: report.format,
            totals: report.totals,
            files: summarize(report.files, changedPaths),
            productionPercent: percentOf(production.coveredLines, production.totalLines),
            productionTotals: production,
            patch,
            hotspots,
        },
    };
}
