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
import { percentOf } from "./types.js";
// A coverage report for a very large solution is still only tens of MB; past
// this it is not something the panel can usefully render.
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
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
function productionPercent(files) {
    let covered = 0;
    let total = 0;
    for (const f of files) {
        if (!isProductionSource(f.path))
            continue;
        covered += f.coveredLines;
        total += f.totalLines;
    }
    return percentOf(covered, total);
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
    const report = resolveReportSources(parsed, { projectRoot });
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
            productionPercent: productionPercent(report.files),
            patch,
            hotspots,
        },
    };
}
