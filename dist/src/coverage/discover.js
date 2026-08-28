// Finds the coverage report that belongs with a results file. The same test run
// writes coverage into a sibling or a well-known reporting folder, so we can
// find it without asking: TestResults/<guid>/coverage.cobertura.xml for dotnet,
// coverage/lcov.info for vitest/jest/c8, target/site/jacoco/jacoco.xml for
// maven, coverage.xml for coverage.py. Bounded like the results scan.
import { readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { readHead } from "../head.js";
import { hasCoverageExt, looksLikeCoverage, nameScore } from "./formats/detect.js";
import { isTestPath } from "./sources/classify.js";
// Only package-manager caches and tool metadata. A workspace's own packages/
// folder is real source and holds the report in a monorepo, so it is walked;
// the depth and entry budgets below are what bound the scan.
const IGNORE_DIRS = new Set([
    "node_modules", ".git", ".hg", ".svn", ".vs", ".idea", ".venv", "venv",
    ".nuget", ".gradle", ".next", ".nuxt", "__pycache__",
]);
// Folders that exist specifically to hold reports, so they are worth going into
// even though siblings like bin/obj are skipped.
const REPORT_DIRS = new Set(["coverage", "testresults", "test-results", "target", "build", "site", "jacoco", "reports", "out", "artifacts", "htmlcov", "test"]);
const MAX_DEPTH = 5;
const MAX_ENTRIES = 6000;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
// A report only counts as belonging to the run when the two were written around
// the same time. Wide enough that no single run splits across it, and the only
// thing separating a report this run wrote from one an older run left behind.
const MAX_RUN_SKEW_MS = 60 * 60 * 1000;
function isCoverageFile(abs) {
    try {
        const st = statSync(abs);
        if (!st.isFile() || st.size > MAX_REPORT_BYTES)
            return false;
        return looksLikeCoverage(readHead(abs));
    }
    catch {
        return false;
    }
}
function mtimeOf(abs) {
    try {
        return statSync(abs).mtimeMs;
    }
    catch {
        return null;
    }
}
// Every coverage report under `root`, bounded in depth and entries.
function findCoverageFiles(root, opts = {}) {
    const maxDepth = opts.maxDepth ?? MAX_DEPTH;
    const found = [];
    let budget = MAX_ENTRIES;
    const stack = [{ dir: root, depth: 0 }];
    const seen = new Set();
    while (stack.length) {
        const { dir, depth } = stack.pop();
        if (seen.has(dir))
            continue;
        seen.add(dir);
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const ent of entries) {
            if (--budget < 0)
                return found;
            const abs = resolvePath(dir, ent.name);
            if (ent.isDirectory()) {
                if (depth >= maxDepth)
                    continue;
                const lower = ent.name.toLowerCase();
                if (IGNORE_DIRS.has(lower))
                    continue;
                // bin/obj hold build output, but `dotnet test` also drops
                // TestResults under them, so only enter via a known report
                // folder.
                if ((lower === "bin" || lower === "obj" || lower === "dist") && !REPORT_DIRS.has(lower))
                    continue;
                stack.push({ dir: abs, depth: depth + 1 });
                continue;
            }
            if (!ent.isFile() || !hasCoverageExt(ent.name))
                continue;
            if (!isCoverageFile(abs))
                continue;
            try {
                found.push({ path: abs, mtimeMs: statSync(abs).mtimeMs, score: nameScore(ent.name) });
            }
            catch { /* vanished between readdir and stat */ }
        }
    }
    return found;
}
// Best candidate: newest wins, and a recognisable name breaks ties between
// reports written in the same instant, since one run can emit several.
export function pickBest(candidates) {
    let best = null;
    for (const c of candidates) {
        if (!best || c.mtimeMs > best.mtimeMs || (c.mtimeMs === best.mtimeMs && c.score > best.score))
            best = c;
    }
    return best ? best.path : null;
}
// Newest coverage report directly inside one directory (non-recursive).
export function newestCoverageFileIn(dir) {
    return pickBest(coverageCandidatesIn(dir));
}
function coverageCandidatesIn(dir) {
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return [];
    }
    const candidates = [];
    for (const n of names) {
        if (!hasCoverageExt(n))
            continue;
        const abs = resolvePath(dir, n);
        if (!isCoverageFile(abs))
            continue;
        try {
            candidates.push({ path: abs, mtimeMs: statSync(abs).mtimeMs, score: nameScore(n) });
        }
        catch { /* ignore */ }
    }
    return candidates;
}
// Locate the report that belongs with `resultsFile`. Nearest first, because
// closeness beats recency: a stale report elsewhere in the repo could easily be
// newer than the one just written. Location alone is never enough though --
// every candidate must also line up in time with the run, so a report an older
// run left behind is not offered as this one's.
export function discoverCoverageFor(resultsFile, projectRoot) {
    const startDir = dirname(resolvePath(resultsFile));
    const runMtime = mtimeOf(resolvePath(resultsFile));
    // An unwritten results file gives nothing to correlate against, so the
    // search stays as it was rather than rejecting everything.
    const fromRun = (candidates) => pickBest(runMtime === null ? candidates : candidates.filter((c) => Math.abs(c.mtimeMs - runMtime) <= MAX_RUN_SKEW_MS));
    // 1. Next to the results file, then in its parent -- `dotnet test` writes
    //    TestResults/<guid>/coverage.cobertura.xml beside TestResults/*.trx.
    const sibling = fromRun(coverageCandidatesIn(startDir));
    if (sibling)
        return sibling;
    const nearby = fromRun(findCoverageFiles(startDir, { maxDepth: 2 }));
    if (nearby)
        return nearby;
    const parent = dirname(startDir);
    if (parent !== startDir) {
        const fromParent = fromRun(findCoverageFiles(parent, { maxDepth: 2 }));
        if (fromParent)
            return fromParent;
    }
    // 2. The usual reporting folders, checked directly before paying for a
    //    full walk.
    if (projectRoot && existsSync(projectRoot)) {
        const conventional = [
            join(projectRoot, "coverage"),
            join(projectRoot, "target", "site", "jacoco"),
            join(projectRoot, "build", "reports", "jacoco", "test"),
            join(projectRoot, "htmlcov"),
            projectRoot,
        ];
        for (const dir of conventional) {
            const hit = fromRun(coverageCandidatesIn(dir));
            if (hit)
                return hit;
        }
        // 3. Last resort: a bounded walk of the project. Reports under a test
        //    folder are fixtures, not this run's output.
        return fromRun(findCoverageFiles(projectRoot).filter((c) => !isTestPath(relative(projectRoot, c.path))));
    }
    return null;
}
//# sourceMappingURL=discover.js.map