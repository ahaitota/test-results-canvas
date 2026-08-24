// Runs the whole coverage pipeline and produces the state the panel renders:
// parse -> find the real files -> cross with the git diff -> rank -> payload.
//
// Only summaries go over SSE. Per-line hit maps stay on the server and are sent
// with the file's text when a row is expanded (see the /source route).
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve as resolvePath } from "node:path";
import { parseCoverage } from "./formats/detect.js";
import { resolveReportSources, findProjectRoot } from "./sources/resolve.js";
import { normalizeSlashes } from "./sources/paths.js";
import { changedLines } from "./analysis/gitdiff.js";
import { computePatchCoverage } from "./analysis/patch.js";
import { rankUncovered } from "./analysis/rank.js";
import { isProductionSource, isTestPath } from "./sources/classify.js";
import { commentSyntaxFor, nonExecutableLines } from "./sources/executable.js";
import { percentOf, tallyLines, totalsOf } from "./model/totals.js";
// A coverage report for a very large solution is still only tens of MB; past
// this it isn't something the panel can usefully render.
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
// Limits for the pass that re-reads sources to discard comment lines, so the
// work stays bounded on a report naming thousands of files.
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_BYTES = 96 * 1024 * 1024;
// Drop lines the report calls coverable but the source shows to be comments or
// blanks. Both sides of the fraction lose the line, since a "covered" comment
// is no more meaningful than an uncovered one.
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
            // Unreadable source is no proof either way, so nothing is dropped.
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
// One row per file for the panel: its percentage, whether the diff touched it,
// and whether it is itself a test.
function summarize(files, changedPaths) {
    const changedKeys = changedPaths.map((p) => normalizeSlashes(p).toLowerCase());
    return files.map((f) => {
        // git and the report may spell the same file differently, so match on
        // either path, allowing one to be the tail of the other.
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
// Totals counting production code only.
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
// Read one coverage report and derive everything from it. Failure is reported
// with a reason rather than a bare null, so the caller can tell "there is no
// report" from "the report was too big to read".
export function loadCoverageFile(coverageFile, options = {}) {
    const abs = resolvePath(String(coverageFile || ""));
    let mtimeMs;
    let size;
    try {
        const st = statSync(abs);
        if (!st.isFile())
            return { ok: false, reason: "missing" };
        mtimeMs = st.mtimeMs;
        size = st.size;
    }
    catch {
        return { ok: false, reason: "missing" };
    }
    if (size > MAX_REPORT_BYTES)
        return { ok: false, reason: "too-large" };
    let text;
    try {
        text = readFileSync(abs, "utf8");
    }
    catch {
        return { ok: false, reason: "unreadable" };
    }
    const parsed = parseCoverage(text);
    if (!parsed)
        return { ok: false, reason: "not-coverage" };
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
        changedByPath.set(normalizeSlashes(f.absPath), f);
    const production = productionOnly(report.files);
    return {
        ok: true,
        coverage: {
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
        },
    };
}
//# sourceMappingURL=load.js.map