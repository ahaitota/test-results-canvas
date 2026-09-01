// SDK-free HTTP server for the Test Results canvas: serves the view, streams
// updates over SSE, loads TRX/JUnit files, and watches the results directory.
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, basename, relative, isAbsolute, resolve as resolvePath } from "node:path";
import { watch, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { serializeTrx, parseTrx } from "./parsers/trx.js";
import { parseJUnit } from "./parsers/junit.js";
import { labelForPath } from "./labels.js";
import { mergeSources } from "./sources.js";
import { readHead } from "./head.js";
import { composeAskPrompt, composeCoveragePrompt, composePatchCoveragePrompt, composeEnableCoveragePrompt, composeImpactPrompt } from "./ask.js";
import { computeRelevance, identitiesOf, matchAgentTests } from "./diff/relevance.js";
import { rowIdentity } from "./rowkey.js";
import { loadCoverageFile, discoverCoverageFor, newestCoverageFileIn, findProjectRoot, suggestCoverageCommand, readSourceView, hasCoverageExt, changedLines, isGeneratedPath, } from "./coverage/index.js";
import { launchFor, commonParent } from "./reveal.js";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEW_PATH = join(__dirname, "view.js");
const CLIENT_BUNDLE = join(__dirname, "..", "client", "app.js");
// Re-imported only when view.js actually changes, so edits show up on a canvas
// refresh without leaking one cached ESM module per request.
let viewModule;
let viewMtimeMs = -1;
async function renderShell(title, askToken) {
    const mtimeMs = statSync(VIEW_PATH).mtimeMs;
    if (!viewModule || mtimeMs !== viewMtimeMs) {
        viewModule = (await import(`${pathToFileURL(VIEW_PATH).href}?t=${mtimeMs}`));
        viewMtimeMs = mtimeMs;
    }
    return viewModule.renderShell(title, askToken);
}
// Walk up to the folder that owns package.json so bundled samples and local
// report files resolve the same whether this runs compiled (dist/src) or straight
// from source (src) — e.g. the e2e suite loads the compiled dist copy.
function findExtensionRoot(start) {
    let dir = start;
    while (!existsSync(join(dir, "package.json"))) {
        const parent = dirname(dir);
        if (parent === dir)
            return start;
        dir = parent;
    }
    return dir;
}
const EXTENSION_ROOT = findExtensionRoot(__dirname);
const SAMPLES_DIR = join(EXTENSION_ROOT, "samples");
const DEFAULT_FILE = "results.trx";
export const RESULT_EXTS = [".trx", ".xml"];
// Cheap content check so we only treat genuine test-results XML as results.
export function looksLikeResults(xml) {
    const head = String(xml || "").slice(0, 8192);
    return /<testsuites?[\s>]/i.test(head) || /<TestRun[\s>]/i.test(head) || /<UnitTestResult[\s>]/i.test(head);
}
// Newest results file directly inside a directory (non-recursive).
export function newestResultsFileIn(dir) {
    let best = null, bestMtime = -1;
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return null;
    }
    for (const n of names) {
        if (!RESULT_EXTS.some((e) => n.toLowerCase().endsWith(e)))
            continue;
        const abs = resolvePath(dir, n);
        try {
            const st = statSync(abs);
            if (st.isFile() && st.mtimeMs > bestMtime && looksLikeResults(readHead(abs))) {
                best = abs;
                bestMtime = st.mtimeMs;
            }
        }
        catch { /* ignore unreadable */ }
    }
    return best;
}
export function normalizeStatus(raw) {
    const s = String(raw || "").toLowerCase();
    if (s === "pass" || s === "passed" || s === "ok" || s === "success")
        return "pass";
    if (s === "fail" || s === "failed" || s === "error")
        return "fail";
    return "skip";
}
function listLocalNames() {
    try {
        return readdirSync(EXTENSION_ROOT).filter((f) => RESULT_EXTS.some((e) => f.toLowerCase().endsWith(e)));
    }
    catch {
        return [];
    }
}
// Selectable files = local extension-folder reports + discovered project files.
function listResultFiles(discovered) {
    let local = [];
    try {
        local = readdirSync(EXTENSION_ROOT).filter((f) => RESULT_EXTS.some((e) => f.toLowerCase().endsWith(e))).sort();
    }
    catch {
        local = [];
    }
    const extras = [...discovered.keys()].filter((l) => !local.includes(l)).sort();
    return [...local, ...extras];
}
// Resolve a picker name to a safe absolute path (discovered label or a basename
// inside the extension folder — no path traversal). null if missing/unsupported.
function resolveResultPath(name, discovered) {
    const raw = String(name || "");
    if (discovered.has(raw)) {
        const abs = discovered.get(raw);
        return existsSync(abs) ? abs : null;
    }
    const base = basename(raw);
    if (!RESULT_EXTS.some((e) => base.toLowerCase().endsWith(e)))
        return null;
    const full = join(EXTENSION_ROOT, base);
    return existsSync(full) ? full : null;
}
// Parse a named file, auto-detecting TRX vs JUnit by content.
function loadFile(name, discovered) {
    const full = resolveResultPath(name, discovered);
    if (!full)
        return [];
    try {
        const xml = readFileSync(full, "utf8");
        return /<testsuites?[\s>]/i.test(xml) ? parseJUnit(xml) : parseTrx(xml);
    }
    catch {
        return [];
    }
}
// Parse an absolute path, or null when it is missing, unreadable, or not a
// results file at all. Distinct from loadFile()'s empty array: a source set has
// to tell "this file reported no tests" from "this path is not a report".
function parseResultsFile(abs) {
    try {
        const xml = readFileSync(abs, "utf8");
        if (!looksLikeResults(xml))
            return null;
        return /<testsuites?[\s>]/i.test(xml) ? parseJUnit(xml) : parseTrx(xml);
    }
    catch {
        return null;
    }
}
// Persist results as TRX, but only for writable local .trx files (never a
// discovered project file — that's the agent's own output).
function persist(results, name, discovered) {
    if (discovered.has(String(name || "")))
        return;
    const base = basename(String(name || DEFAULT_FILE)) || DEFAULT_FILE;
    if (!base.toLowerCase().endsWith(".trx"))
        return;
    try {
        writeFileSync(join(EXTENSION_ROOT, base), serializeTrx(results, { runName: "Test Results" }), "utf8");
    }
    catch (err) {
        console.error("[server] failed to write TRX:", err instanceof Error ? err.message : err);
    }
}
function registerSamples(discovered) {
    try {
        for (const f of readdirSync(SAMPLES_DIR)) {
            if (RESULT_EXTS.some((e) => f.toLowerCase().endsWith(e)))
                discovered.set(f, join(SAMPLES_DIR, f));
        }
    }
    catch { /* no samples bundled */ }
}
// Hand the run to the desktop shell. Detached and argv-based: no shell parses
// the path, and the launched app outlives this server. Exit codes are ignored on
// purpose (explorer.exe reports failure on success); only a failure to spawn --
// no opener installed -- is an error.
//
// `windowsHide` must stay off: it reaches the child as SW_HIDE in its
// STARTUPINFO, and Explorer applies that to the folder window it opens, which
// then exists but is invisible.
function spawnLaunch({ command, args, verbatim }) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: verbatim });
        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}
export async function createResultsServer(options = {}) {
    // watch=false disables the results-dir watcher.
    const { resultsFile, resultsDir, title = "Test Results", port = 0, watch: watchEnabled = true, onAsk } = options;
    const coverageEnabled = options.coverage !== false;
    const launch = options.launch ?? spawnLaunch;
    // The server listens on a fixed, guessable port, so /ask -- which can drive
    // the user's agent -- is gated on a secret minted per instance and handed
    // only to the page this server rendered.
    const askToken = randomBytes(16).toString("hex");
    const discovered = new Map();
    registerSamples(discovered);
    for (const p of options.alsoRegister || []) {
        try {
            const abs = resolvePath(String(p));
            if (existsSync(abs))
                discovered.set(labelForPath(abs, discovered, listLocalNames()), abs);
        }
        catch { /* ignore */ }
    }
    const clients = new Set();
    let file = DEFAULT_FILE;
    let results = [];
    // The active source set. One entry is the classic single-file case; several
    // is a merged run. Empty means nothing was seeded, and `results` is then
    // owned directly by the report/clear actions.
    let entries = [];
    // The display name of a merged run, or null when a single file is loaded.
    let groupName = null;
    // The group that was opened, remembered independently of what is displayed:
    // picking one member out of the picker switches the view, and must not
    // destroy the only way back to the merge.
    let groupDef = null;
    // One watcher per directory the sources live in.
    const watchers = new Map();
    // Held at this level so closing the server can cancel a reload that was
    // already queued. Keyed by absolute path, so two sources in one folder
    // debounce independently.
    const resultsTimers = new Map();
    // `coverageWatcher` follows the report's folder so a re-run refreshes the
    // panel the same way results already do.
    let coverage = null;
    let coverageWatcher = null;
    // What the panel has been asked to show, kept apart from what it managed to
    // load. Requests outlive their failures: a report named before the run that
    // writes it does not exist yet, and that is normal rather than an error.
    let coverageTarget = null;
    let coverageWatchDir = null;
    // Identity of the report on screen, so disk can be compared against it
    // without re-reading it.
    let coverageStamp = null;
    let coverageRevision = 0;
    // Looks for what the watcher cannot see. Runs while there is a request.
    let coveragePoll = null;
    let coverageTimer = null;
    // Bumped every time the watcher is retired, so a callback already queued
    // against the old folder cannot resurrect the report it belonged to.
    let coverageWatchGeneration = 0;
    let projectRoot;
    // A root the caller named. Inference must never overwrite it: the agent ran
    // the command and knows which package the report belongs to.
    let explicitProjectRoot = options.projectRoot ? resolvePath(String(options.projectRoot)) : undefined;
    if (explicitProjectRoot)
        projectRoot = explicitProjectRoot;
    let coverageHint = null;
    // Set when a report was found but could not be used, so the empty state can
    // say why instead of implying no coverage was collected.
    let coverageError = null;
    // A report the caller named, and the run it was named for: an explicit
    // report belongs to that run, not to whatever run is loaded next. Null
    // means "named before any run was known".
    let explicitCoverageInput = null;
    let explicitCoverageFor = null;
    // The run on screen. A panel opened on a folder keeps the same run as it
    // re-runs, under whatever name each writes.
    let resultsAbsPath = null;
    // Set when the caller named a coverage report outright, so a results refresh
    // never re-discovers over the top of an explicit choice.
    let explicitCoverage = false;
    let resultsTarget = null;
    // --- Diff mode (issue #8) ---
    //
    // `baseline`: identities of the previous run, so a test appearing out of
    // nowhere is new. Carried across only when the *same* file reloads.
    // `agentImpact`: keyed by identity, not index, so the agent's answer
    // survives the re-run it usually triggers.
    let diff = null;
    let baseline = null;
    let agentImpact = null;
    // The raw diff behind `diff`. Off the wire, but the impact prompt uses it.
    let lastChanges = null;
    // Tracked separately from resultsAbsPath, which only exists with coverage on.
    let loadedResultsPath = null;
    const loadOptions = () => ({
        projectRoot,
        skipGit: options.gitExec === null,
        diff: options.gitExec ? { exec: options.gitExec } : undefined,
    });
    function refreshCoverageHint() {
        coverageHint = coverageEnabled ? suggestCoverageCommand(projectRoot, resultsAbsPath ?? undefined) : null;
    }
    // The agent's tags, mapped from identities back to current row indexes.
    // A test it named that this run no longer has drops out.
    function agentIndexes() {
        if (!agentImpact?.size)
            return null;
        const out = new Map();
        for (let i = 0; i < results.length; i++) {
            const reason = agentImpact.get(rowIdentity(results[i]));
            if (reason)
                out.set(i, reason);
        }
        return out.size ? out : null;
    }
    // Re-tag the loaded run from the diff already read. Cheap: no subprocess.
    function retag() {
        diff = computeRelevance({ results, baseline, changes: lastChanges, agent: agentIndexes() });
    }
    // Ask git what changed, then re-tag. Once per results load, never per row.
    function refreshDiff() {
        if (options.gitExec === null) {
            diff = null;
            lastChanges = null;
            return;
        }
        const root = projectRoot ?? (loadedResultsPath ? findProjectRoot(dirname(loadedResultsPath)) : undefined);
        // includeTests: an edited test file is the whole point here.
        const raw = root
            ? changedLines(root, { includeTests: true, ...(options.gitExec ? { exec: options.gitExec } : {}) })
            : null;
        // Build output is not a change anyone can test, and a repo that commits
        // its dist/ would otherwise bury the real edits in the count and prompt.
        lastChanges = raw ? { ...raw, files: raw.files.filter((f) => !isGeneratedPath(f.path)) } : null;
        retag();
    }
    // Swap in a new run. Reloading the same `fromPath` hands its identities on
    // as the baseline; switching files starts clean.
    function applyResults(next, fromPath) {
        const continues = Boolean(fromPath) && fromPath === loadedResultsPath;
        baseline = continues && results.length ? identitiesOf(results) : null;
        // The agent's conclusions were about the run that just went away.
        if (!continues)
            agentImpact = null;
        loadedResultsPath = fromPath;
        results = next;
        refreshDiff();
    }
    function statePayload() {
        return JSON.stringify({
            title,
            results,
            file,
            files: selectableFiles(),
            reveal: revealTarget(),
            // Null for the classic single-file case, so a one-file panel renders
            // exactly as it did. Only what the header shows: a path would be
            // payload the UI never reads.
            group: groupName
                ? { name: groupName, sources: entries.map((e) => ({ label: e.source.label, count: e.source.count })) }
                : null,
            coverage: coverage ? { ...coverage.payload, revision: coverageRevision } : null,
            coverageHint,
            diff,
            coverageError,
        });
    }
    function broadcast() {
        for (const res of clients)
            res.write(`data: ${statePayload()}\n\n`);
    }
    function reload() {
        for (const res of clients)
            res.write(`event: reload\ndata: 1\n\n`);
    }
    function stopWatchers() {
        // Timers first: a reload already queued must not fire against a folder
        // this server has stopped watching.
        for (const t of resultsTimers.values())
            clearTimeout(t);
        resultsTimers.clear();
        for (const w of watchers.values()) {
            try {
                w.close();
            }
            catch { /* already closed */ }
        }
        watchers.clear();
    }
    function stopCoverageWatcher() {
        // Retire the current generation first: a debounced callback that has
        // already been queued must not act on the folder we are leaving.
        coverageWatchGeneration++;
        if (coverageTimer) {
            clearTimeout(coverageTimer);
            coverageTimer = null;
        }
        if (!coverageWatcher)
            return;
        try {
            coverageWatcher.close();
        }
        catch { /* already closed */ }
        coverageWatcher = null;
        coverageWatchDir = null;
    }
    // --- Coverage loading ---
    // Forget the request and everything that came of it. Used when the run
    // changes: whatever comes next belongs to a different run.
    function clearCoverage() {
        coverage = null;
        coverageError = null;
        coverageTarget = null;
        coverageStamp = null;
        armCoverageWatch();
    }
    function targetDir(t) {
        return t.kind === "file" ? dirname(t.path) : t.dir;
    }
    function targetHolds(t, path) {
        return t.kind === "file" ? t.path === path : dirname(path) === t.dir;
    }
    function coveragePathOf(t) {
        return t.kind === "file" ? t.path : (existsSync(t.dir) ? newestCoverageFileIn(t.dir) : null);
    }
    // Enough of a file to notice it being rewritten without reading it.
    function stampOf(path) {
        if (!path)
            return null;
        try {
            const s = statSync(path);
            return `${path}:${s.mtimeMs}:${s.size}`;
        }
        catch {
            return null;
        }
    }
    // Keep a watcher on the folder holding the report on screen, so its next
    // rewrite shows up at once. The watcher is a shortcut for the common case,
    // not the source of truth -- `syncCoveragePoll` is what guarantees a change
    // is noticed.
    function armCoverageWatch() {
        const t = coverageTarget;
        if (coverage && t && watchEnabled) {
            const dir = targetDir(t);
            if (dir !== coverageWatchDir)
                watchCoverageDir(dir);
        }
        else {
            stopCoverageWatcher();
        }
        syncCoveragePoll();
    }
    // Compare disk against the panel for as long as there is a request to
    // answer. A directory watcher cannot carry this alone: the folder may not
    // exist yet, may be built a level at a time, and may be swapped out without
    // an event arriving. A tick costs a stat.
    function syncCoveragePoll() {
        const wanted = watchEnabled && coverageTarget !== null;
        if (wanted === (coveragePoll !== null))
            return;
        if (!wanted)
            return stopCoveragePoll();
        coveragePoll = setInterval(() => {
            if (coverageMoved() && settleCoverage())
                broadcast();
        }, 500);
        coveragePoll.unref?.();
    }
    // Whether disk still says what the panel is showing. The watcher and the
    // poll share it, so whichever notices a write first does the reading. A
    // failed target is stamped like any other, so a file that cannot be read is
    // not read again until it changes; a missing one stamps as null and is
    // picked up the moment it appears.
    function coverageMoved() {
        const t = coverageTarget;
        if (!t)
            return false;
        return stampOf(coveragePathOf(t)) !== coverageStamp;
    }
    function stopCoveragePoll() {
        if (!coveragePoll)
            return;
        clearInterval(coveragePoll);
        coveragePoll = null;
    }
    // Read the target again and put the watcher and the poll where they belong.
    // Returns whether anything the panel shows changed.
    function settleCoverage() {
        if (!coverageTarget)
            return false;
        const changed = refreshCoverage();
        armCoverageWatch();
        return changed;
    }
    // Make what the panel shows match what it was asked for, reading from disk.
    // Returns true when clients need telling. A report that has gone bad counts
    // as a change, since the numbers on screen no longer describe anything.
    function refreshCoverage() {
        const t = coverageTarget;
        if (!t)
            return false;
        const path = coveragePathOf(t);
        const loaded = path ? loadCoverageFile(path, loadOptions()) : null;
        if (!loaded?.ok) {
            // The target is kept: a report is routinely absent or half-written
            // for a moment during a run, and the next look recovers it.
            const reason = loaded ? loaded.reason : "missing";
            const changed = coverage !== null || coverageError !== reason;
            coverage = null;
            coverageError = reason;
            coverageStamp = stampOf(path);
            refreshCoverageHint();
            return changed;
        }
        // Any successful read counts as a change: a re-run overwrites the report
        // in place, so its path stays the same.
        coverage = loaded.coverage;
        coverageError = null;
        coverageStamp = stampOf(path);
        coverageRevision++;
        if (!projectRoot)
            projectRoot = loaded.coverage.projectRoot;
        refreshCoverageHint();
        return true;
    }
    // Take on a target a caller named. It becomes the request whether or not it
    // loads, so a failure is what the panel shows, and a target that does not
    // exist yet is waited for.
    function requestCoverage(t) {
        coverageTarget = t;
        settleCoverage();
        return coverage !== null;
    }
    // Try a candidate discovery came up with. Only a guess, so it becomes the
    // request only if it loads. From then on its folder is followed, because a
    // re-run may write the report under a new name.
    function tryCoverage(absPath) {
        const loaded = loadCoverageFile(absPath, loadOptions());
        if (!loaded.ok)
            return false;
        coverage = loaded.coverage;
        coverageError = null;
        coverageTarget = { kind: "dir", dir: dirname(absPath) };
        coverageStamp = stampOf(absPath);
        coverageRevision++;
        if (!projectRoot)
            projectRoot = loaded.coverage.projectRoot;
        refreshCoverageHint();
        armCoverageWatch();
        return true;
    }
    // Separate from the results watcher because the two files usually live in
    // different folders (`coverage/lcov.info` vs `test-results/junit.xml`).
    function watchCoverageDir(dir) {
        stopCoverageWatcher();
        const generation = coverageWatchGeneration;
        coverageWatchDir = dir;
        try {
            coverageWatcher = watch(dir, { persistent: false }, (_event, filename) => {
                if (generation !== coverageWatchGeneration)
                    return;
                if (!filename || !hasCoverageExt(String(filename)))
                    return;
                if (coverageTimer)
                    clearTimeout(coverageTimer);
                coverageTimer = setTimeout(() => {
                    coverageTimer = null;
                    if (coverageMoved() && settleCoverage())
                        broadcast();
                }, 400);
            });
            coverageWatcher.on("error", (err) => console.error("[server] coverage watcher error:", err?.message || err));
        }
        catch (err) {
            console.error(`[server] coverage watch failed for ${dir}:`, err instanceof Error ? err.message : err);
        }
    }
    // Find and load the report that belongs with the results file just loaded.
    // Whatever was loaded before belongs to a different run.
    function attachCoverage(resultsAbs) {
        if (!coverageEnabled)
            return;
        resultsAbsPath = resultsAbs;
        if (resultsAbs && !explicitProjectRoot)
            projectRoot = findProjectRoot(dirname(resultsAbs));
        clearCoverage();
        refreshCoverageHint();
        if (!resultsAbs)
            return;
        // A report named for this run outranks anything discovery would guess
        // at. One named for a different run is not reused.
        if (explicitCoverageInput && (explicitCoverageFor === null || targetHolds(explicitCoverageFor, resultsAbs))) {
            seedCoverage(explicitCoverageInput, resultsAbs);
            return;
        }
        explicitCoverageInput = null;
        explicitCoverageFor = null;
        const found = discoverCoverageFor(resultsAbs, projectRoot);
        if (found)
            tryCoverage(found);
    }
    // Coverage for a merged run is deliberately NOT merged: N test projects
    // write N reports, and stitching them is its own problem. So a report is
    // attached only when exactly one source has one — showing project A's
    // coverage beside A+B+C results would read as coverage for all of it.
    function attachCoverageForSources() {
        if (!coverageEnabled)
            return;
        if (entries.length <= 1) {
            attachCoverage(entries[0]?.source.path ?? null);
            return;
        }
        // Locality is enforced here, not by how discoverCoverageFor is called:
        // it deliberately searches wider than one project. Its nearby walk is
        // what finds dotnet's TestResults/<guid>/coverage.cobertura.xml, which
        // sits below the .trx's own folder and is wanted; its parent walk is
        // not, because in a solution the parent holds the sibling projects, so
        // every source would "find" a report and none would look like an owner.
        // A report counts as this source's own only if it lives under it.
        const owns = (resultsPath) => {
            const found = discoverCoverageFor(resultsPath);
            if (!found)
                return false;
            // relative() rather than a startsWith on the path: it honours the
            // platform's case rules, and it will not count a sibling that merely
            // shares a name prefix (ProjA.Tests against ProjA).
            const rel = relative(dirname(resultsPath), found);
            return !rel.startsWith("..") && !isAbsolute(rel);
        };
        const owners = entries.map((e) => e.source.path).filter(owns);
        if (owners.length === 1) {
            attachCoverage(owners[0]);
            return;
        }
        // No single report speaks for the merged run: show none, and let the
        // existing hint say how to produce one. Cleared through clearCoverage so
        // the previous run's error and its outstanding request go too — a
        // request left standing keeps the poll alive, which would re-attach the
        // very report this branch declined to show.
        clearCoverage();
        resultsAbsPath = entries[0].source.path;
        // Inference must not overwrite a root the caller named.
        if (!explicitProjectRoot)
            projectRoot = findProjectRoot(dirname(resultsAbsPath));
        refreshCoverageHint();
    }
    // --- The source set ---
    // The merged run appears in the picker under its own name, alongside the
    // individual files. Listed from the group that was opened rather than the
    // one on screen, so drilling into a member leaves a way back.
    function selectableFiles() {
        const list = listResultFiles(discovered);
        const name = groupDef?.name;
        return name && !list.includes(name) ? [name, ...list] : list;
    }
    // What /reveal acts on. A single run is its file; a merged run has no single
    // file, so it is the folder its sources share. Null when nothing on disk
    // backs the rows on screen -- results the agent reported, or a report
    // deleted since it was loaded.
    function revealTarget() {
        // An action replaces the rows without touching the sources, so the file
        // they came from is no longer what is on screen.
        if (!loadedResultsPath)
            return null;
        const paths = entries.map((e) => e.source.path);
        if (!paths.length)
            return null;
        const target = paths.length === 1
            ? { kind: "file", path: paths[0] }
            : (() => {
                const dir = commonParent(paths, process.platform);
                return dir ? { kind: "dir", path: dir } : null;
            })();
        return target && existsSync(target.path) ? target : null;
    }
    function buildEntry(abs) {
        const rows = parseResultsFile(abs);
        if (rows === null)
            return null;
        const label = labelForPath(abs, discovered, listLocalNames());
        discovered.set(label, abs);
        return { source: { label, path: abs, count: rows.length }, rows };
    }
    // Resolve named files into sources, reporting what fell out so the caller
    // can hand back a receipt rather than a silent partial merge.
    function collectSources(files) {
        const built = [];
        const skipped = [];
        const seen = new Set();
        for (const raw of files) {
            const abs = resolvePath(raw);
            if (seen.has(abs)) {
                skipped.push({ path: raw, reason: "duplicate of another source" });
                continue;
            }
            seen.add(abs);
            if (!existsSync(abs)) {
                skipped.push({ path: raw, reason: "no such file" });
                continue;
            }
            const entry = buildEntry(abs);
            if (!entry) {
                skipped.push({ path: raw, reason: "not a readable test-results file" });
                continue;
            }
            built.push(entry);
        }
        return { entries: built, skipped };
    }
    // Swap in a new set and rebuild everything that hangs off it.
    function applySources(list, name) {
        entries = list;
        groupName = name;
        // Recorded from what actually resolved, so a path that could not be read
        // is not retried on every restore.
        if (name)
            groupDef = { name, paths: list.map((e) => e.source.path) };
        rebuild();
        if (watchEnabled)
            syncWatchers();
    }
    function rebuild() {
        // One file is not a merged run: tagging its rows would put a "File" the
        // picker already names into every row's detail. Sliced rather than used
        // directly, so add_result can't grow the source's cached parse.
        const rows = entries.length === 1
            ? entries[0].rows.slice()
            : mergeSources(entries.map((e) => ({ source: e.source, results: e.rows })));
        // Through applyResults so diff mode sees the new rows. It wants one path
        // to find a git root from, and any source will do: changedLines resolves
        // the repository top level itself, so every member of a group in one
        // checkout yields the same diff. Passing the first keeps it stable across
        // re-runs, which is what lets the baseline mark genuinely new tests.
        applyResults(rows, entries[0]?.source.path ?? null);
        if (entries.length)
            file = groupName ?? entries[0].source.label;
    }
    // Re-read one source in place. False when nothing usable came back, so a
    // half-written file keeps showing the rows it already had.
    function reparse(entry, abs) {
        const rows = parseResultsFile(abs);
        if (rows === null)
            return false;
        const label = abs === entry.source.path ? entry.source.label : labelForPath(abs, discovered, listLocalNames());
        if (abs !== entry.source.path)
            discovered.set(label, abs);
        entry.rows = rows;
        entry.source = { label, path: abs, count: rows.length };
        return true;
    }
    // Only the sources living in `dir` are touched: a five-project group must
    // not re-read four untouched files because the fifth was rewritten.
    function refreshDir(dir, changedName) {
        const here = entries.filter((e) => dirname(e.source.path) === dir);
        let changed = false, moved = false;
        if (here.length === 1) {
            // Alone in its folder, a source follows that folder's newest report:
            // `dotnet test` writes a fresh <machine>_<user>_<timestamp>.trx per
            // run instead of overwriting, and re-deriving is how a single named
            // file has always stayed live.
            //
            // Sources that SHARE a folder must not do this. They would all
            // re-resolve onto the same newest file and quietly collapse into one,
            // losing the rest of the merge — so they re-parse their own path.
            const abs = newestResultsFileIn(dir) ?? here[0].source.path;
            moved = abs !== here[0].source.path;
            changed = reparse(here[0], abs);
        }
        else {
            for (const entry of here) {
                if (basename(entry.source.path) === changedName && reparse(entry, entry.source.path))
                    changed = true;
            }
        }
        if (!changed)
            return;
        rebuild();
        // A moved report means the coverage beside it moved too. An explicitly
        // named report is left alone — the caller chose it.
        if (moved && !explicitCoverage)
            attachCoverageForSources();
        broadcast();
    }
    function startWatch(dir) {
        try {
            const w = watch(dir, { persistent: false }, (_event, filename) => {
                if (!filename)
                    return;
                const name = String(filename);
                if (!RESULT_EXTS.some((e) => name.toLowerCase().endsWith(e)))
                    return;
                // Keyed by absolute path rather than bare name: two watched
                // folders can each hold a `results.trx`, and they must not
                // cancel one another's pending reload.
                const abs = resolvePath(dir, name);
                clearTimeout(resultsTimers.get(abs));
                resultsTimers.set(abs, setTimeout(() => {
                    resultsTimers.delete(abs);
                    refreshDir(dir, name);
                }, 400));
            });
            w.on("error", (err) => console.error("[server] watcher error:", err?.message || err));
            watchers.set(dir, w);
        }
        catch (err) {
            console.error(`[server] watch failed for ${dir}:`, err instanceof Error ? err.message : err);
        }
    }
    // One watcher per directory the sources live in, recomputed from the active
    // set: several sources in one folder share a watcher, and a folder nothing
    // points at any more is dropped.
    function syncWatchers() {
        const wanted = new Set(entries.map((e) => dirname(e.source.path)));
        for (const [dir, w] of watchers) {
            if (wanted.has(dir))
                continue;
            try {
                w.close();
            }
            catch { /* already closed */ }
            watchers.delete(dir);
        }
        for (const dir of wanted)
            if (!watchers.has(dir))
                startWatch(dir);
    }
    // Seed from a set of files, or from the original single file/dir.
    function seed(input) {
        let loaded = false;
        const files = input.resultsFiles ?? [];
        if (files.length) {
            const built = collectSources(files);
            if (built.entries.length) {
                applySources(built.entries, groupNameFor(input.name, built.entries.length));
                loaded = true;
            }
        }
        if (!loaded && (input.resultsFile || input.resultsDir)) {
            let abs = null;
            if (input.resultsFile) {
                const p = resolvePath(String(input.resultsFile));
                // isFile, so a folder handed to resultsFile falls through to the
                // resultsDir branch rather than swallowing it; and the head is
                // sniffed so something that is not a report falls through too
                // rather than blanking the panel.
                try {
                    if (existsSync(p) && statSync(p).isFile() && looksLikeResults(readHead(p)))
                        abs = p;
                }
                catch { /* unreadable */ }
            }
            if (!abs && input.resultsDir) {
                const d = resolvePath(String(input.resultsDir));
                if (existsSync(d))
                    abs = newestResultsFileIn(d);
            }
            const entry = abs ? buildEntry(abs) : null;
            if (entry) {
                applySources([entry], null);
                // A fresh seed re-points the whole panel, so a group left over
                // from a previous open must not stay in the picker.
                groupDef = null;
                loaded = true;
            }
        }
        // Honoured even when no results file resolved: the agent may be pointing
        // the panel at coverage for a run whose report it could not find.
        explicitCoverage = seedCoverage(input, entries[0]?.source.path ?? null);
        if (!loaded)
            return null;
        if (!explicitCoverage)
            attachCoverageForSources();
        return entries[0].source.path;
    }
    // One source is never a group, however it was opened and whatever the caller
    // called it: there is nothing to group by, so a name would only buy the UI a
    // File grouping that buckets every row under "(no file)".
    function groupNameFor(name, count) {
        return count > 1 ? (name || "Merged results") : null;
    }
    // Load one file on its own, leaving any merged run behind — picking a file
    // outside it is a deliberate departure. `label` is the picker name chosen,
    // which is what the <select> expects to see back. `groupDef` survives, so
    // the merge stays listed and can be picked again.
    function loadSingle(abs, label) {
        const entry = buildEntry(abs);
        // Registered but unparseable: keep the old behaviour of showing an empty
        // run rather than refusing the selection outright.
        applySources(entry ? [entry] : [], null);
        file = label;
        attachCoverage(abs);
    }
    // Re-open the group after drilling into one of its files. Re-collected from
    // disk rather than cached, so a member rewritten meanwhile comes back
    // current. False when nothing resolves any more, leaving the view alone.
    function restoreGroup(def) {
        const built = collectSources(def.paths);
        // A member deleted since the group was opened drops out; the rest still
        // merge, and the per-source counts in the header show what came back.
        if (!built.entries.length)
            return false;
        // Decayed to one readable file, it is no longer a merge — but `groupDef`
        // stays, because the group still exists and the member may return.
        applySources(built.entries, groupNameFor(def.name, built.entries.length));
        if (!explicitCoverage)
            attachCoverageForSources();
        return true;
    }
    // A merged run is spread over files this server does not own, so a report or
    // clear action would be thrown away by the next refresh. Refuse, with
    // something the agent can act on.
    function denyWrite() {
        if (!groupName)
            return null;
        const n = entries.length;
        return {
            ok: false,
            error: `"${groupName}" is ${n} results file${n === 1 ? "" : "s"} merged into one run. ` +
                `Reporting or clearing results would discard the merge, and these files belong to the test run, not to this panel. ` +
                `Load a single file first, or re-run the tests and reopen the canvas with the new files.`,
        };
    }
    // True when an explicit coverageFile/coverageDir produced a report. The
    // pointer is remembered either way, paired with the run it was given for,
    // so a later reload of that run uses it instead of falling back to
    // discovery.
    function seedCoverage(input, resultsAbs) {
        if (!coverageEnabled)
            return false;
        resultsAbsPath = resultsAbs ?? resultsAbsPath;
        if (input.resultsDir)
            resultsTarget = { kind: "dir", dir: resolvePath(String(input.resultsDir)) };
        else if (resultsAbs)
            resultsTarget = { kind: "file", path: resultsAbs };
        if (input.projectRoot) {
            const next = resolvePath(String(input.projectRoot));
            const moved = next !== projectRoot;
            explicitProjectRoot = next;
            projectRoot = next;
            // Sources and the diff are resolved against the root, so a report
            // already on screen was read against the old one. Skipped when this
            // call also names a report, read against the new root below anyway.
            if (moved && coverageTarget && !input.coverageFile && !input.coverageDir)
                settleCoverage();
        }
        const named = Boolean(input.coverageFile || input.coverageDir);
        if (named) {
            explicitCoverageInput = input;
            // Coverage named on its own answers for the run on screen now, not
            // for whichever run is loaded next.
            explicitCoverageFor = resultsTarget;
        }
        // The run is what the panel is about, so its package decides the root.
        // Re-derived on every seed: a canvas reopened for another project would
        // otherwise resolve sources and the diff against the previous one.
        if (!explicitProjectRoot && resultsAbsPath)
            projectRoot = findProjectRoot(dirname(resultsAbsPath));
        if (input.coverageFile) {
            const p = resolvePath(String(input.coverageFile));
            if (!projectRoot)
                projectRoot = findProjectRoot(dirname(p));
            if (requestCoverage({ kind: "file", path: p }))
                return true;
        }
        if (input.coverageDir) {
            const d = resolvePath(String(input.coverageDir));
            const found = existsSync(d) ? newestCoverageFileIn(d) : null;
            if (found && !projectRoot)
                projectRoot = findProjectRoot(dirname(found));
            // A named folder holding nothing is still the request: the run that
            // fills it may not have finished. Skipped only when a named file
            // already failed, since that reason is the more specific one.
            if (found || !input.coverageFile) {
                if (requestCoverage({ kind: "dir", dir: d }))
                    return true;
            }
        }
        return false;
    }
    if (!seed({
        name: options.name,
        resultsFile,
        resultsDir,
        resultsFiles: options.resultsFiles,
        coverageFile: options.coverageFile,
        coverageDir: options.coverageDir,
    })) {
        // Nothing seeded: fall back to a results.trx sitting in the extension
        // folder, which is also what the report/clear actions write to.
        applyResults(loadFile(file, discovered), null);
        // No results file resolved, but an explicit coverage report may still
        // have been given, and the hint needs a project root either way.
        if (coverageEnabled && !coverage)
            refreshCoverageHint();
    }
    // Read a small JSON body. Still capped even though callers are authenticated
    // by this point, so a wedged page cannot grow the buffer without limit.
    async function readJsonBody(req) {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
            const buf = chunk;
            size += buf.length;
            if (size > 8192)
                throw new Error("body too large");
            chunks.push(buf);
        }
        // Decoded once at the end: a chunk boundary can fall inside a multi-byte
        // character, and decoding each chunk alone would turn its halves into
        // replacement characters.
        const text = Buffer.concat(chunks).toString("utf8");
        try {
            return JSON.parse(text || "null");
        }
        catch {
            throw new Error("invalid JSON");
        }
    }
    // `Authorization: Bearer <token>` rather than a body field so the check below
    // can run before the body is read.
    function bearerToken(req) {
        const header = req.headers.authorization ?? "";
        return header.startsWith("Bearer ") ? header.slice(7) : "";
    }
    function sendJson(res, status, body) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
    }
    // The page posts a row reference, never prompt text: the message is composed
    // here from this server's own results, so nothing that reaches the agent is
    // caller-supplied. `name` is checked against the index to catch a click that
    // raced a refresh, which would otherwise ask about the wrong test.
    async function handleAsk(req, res) {
        if (req.method !== "POST")
            return sendJson(res, 405, { ok: false, error: "POST required" });
        if (!onAsk)
            return sendJson(res, 501, { ok: false, error: "asking the agent is not available" });
        // Before the body is touched, so an unauthenticated caller cannot make
        // this server buffer anything.
        if (bearerToken(req) !== askToken)
            return sendJson(res, 403, { ok: false, error: "bad token" });
        let body;
        try {
            body = await readJsonBody(req);
        }
        catch (err) {
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad request" });
        }
        const payload = (body ?? {});
        if (typeof payload.index !== "number" || !Number.isInteger(payload.index)) {
            return sendJson(res, 400, { ok: false, error: "index must be an integer" });
        }
        const test = results[payload.index];
        if (!test)
            return sendJson(res, 404, { ok: false, error: "no such row" });
        if (typeof payload.name === "string" && payload.name !== test.name) {
            return sendJson(res, 409, { ok: false, error: "results changed, reopen the row" });
        }
        try {
            await onAsk({ prompt: composeAskPrompt(test), test });
        }
        catch (err) {
            console.error("[server] onAsk failed:", err instanceof Error ? err.message : err);
            return sendJson(res, 502, { ok: false, error: "could not reach the session" });
        }
        return sendJson(res, 200, { ok: true });
    }
    // Same rule as /ask: the page names a scope and the prompt is composed here
    // from server-held data. Nothing the caller sends reaches the agent.
    async function handleAskCoverage(req, res) {
        if (req.method !== "POST")
            return sendJson(res, 405, { ok: false, error: "POST required" });
        if (!onAsk)
            return sendJson(res, 501, { ok: false, error: "asking the agent is not available" });
        if (bearerToken(req) !== askToken)
            return sendJson(res, 403, { ok: false, error: "bad token" });
        let body;
        try {
            body = await readJsonBody(req);
        }
        catch (err) {
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad request" });
        }
        const payload = (body ?? {});
        const scope = payload.scope;
        if (scope !== "file" && scope !== "patch" && scope !== "enable") {
            return sendJson(res, 400, { ok: false, error: "scope must be 'file', 'patch' or 'enable'" });
        }
        let prompt;
        if (scope === "enable") {
            const hint = coverageHint ?? suggestCoverageCommand(projectRoot, resultsAbsPath ?? undefined);
            prompt = composeEnableCoveragePrompt(hint.command, hint.ecosystem);
        }
        else if (scope === "patch") {
            const patch = coverage?.payload.patch;
            if (!patch)
                return sendJson(res, 404, { ok: false, error: "no changed-code coverage to ask about" });
            prompt = composePatchCoveragePrompt(patch);
        }
        else {
            if (typeof payload.path !== "string")
                return sendJson(res, 400, { ok: false, error: "path must be a string" });
            // Looked up in the report rather than trusted: an unknown path is
            // rejected, so the prompt can only ever describe measured code.
            const entry = coverage?.report.files.find((f) => f.path === payload.path);
            if (!entry)
                return sendJson(res, 404, { ok: false, error: "no such file in the coverage report" });
            const uncoveredLines = Object.entries(entry.lines).filter(([, hits]) => hits === 0).map(([line]) => Number(line));
            prompt = composeCoveragePrompt({
                path: entry.path,
                uncoveredLines,
                percent: entry.totalLines ? Math.round((entry.coveredLines / entry.totalLines) * 100) : null,
            });
        }
        try {
            await onAsk({ prompt, coverage: { scope, path: scope === "file" ? String(payload.path) : undefined } });
        }
        catch (err) {
            console.error("[server] onAsk (coverage) failed:", err instanceof Error ? err.message : err);
            return sendJson(res, 502, { ok: false, error: "could not reach the session" });
        }
        return sendJson(res, 200, { ok: true });
    }
    // "Which tests does this change affect?" Same rule as /ask: the page names
    // the scope, the prompt is composed here, and the answer comes back as
    // canvas tags through set_impacted_tests rather than as text.
    async function handleAskImpact(req, res) {
        if (req.method !== "POST")
            return sendJson(res, 405, { ok: false, error: "POST required" });
        if (!onAsk)
            return sendJson(res, 501, { ok: false, error: "asking the agent is not available" });
        if (bearerToken(req) !== askToken)
            return sendJson(res, 403, { ok: false, error: "bad token" });
        if (!lastChanges || !lastChanges.files.length) {
            return sendJson(res, 404, { ok: false, error: "no changes to analyse" });
        }
        const prompt = composeImpactPrompt({
            against: lastChanges.against,
            files: lastChanges.files.map((f) => f.path),
            changedFiles: lastChanges.files.length,
            totalTests: results.length,
        });
        try {
            await onAsk({ prompt, diff: { scope: "impact" } });
        }
        catch (err) {
            console.error("[server] onAsk (impact) failed:", err instanceof Error ? err.message : err);
            return sendJson(res, 502, { ok: false, error: "could not reach the session" });
        }
        return sendJson(res, 200, { ok: true });
    }
    // Reveal or open the run through the desktop shell. The page chooses the
    // action, never the path: that comes from this server's own source set, so a
    // page cannot name an unrelated file. Token-gated exactly like /ask.
    async function handleReveal(req, res) {
        if (req.method !== "POST")
            return sendJson(res, 405, { ok: false, error: "POST required" });
        if (bearerToken(req) !== askToken)
            return sendJson(res, 403, { ok: false, error: "bad token" });
        let body;
        try {
            body = await readJsonBody(req);
        }
        catch (err) {
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad request" });
        }
        const mode = body?.mode;
        if (mode !== "reveal" && mode !== "open") {
            return sendJson(res, 400, { ok: false, error: "mode must be 'reveal' or 'open'" });
        }
        const target = revealTarget();
        if (!target)
            return sendJson(res, 404, { ok: false, error: "this run has no report file on disk" });
        const command = launchFor(mode, target, process.platform);
        if (!command)
            return sendJson(res, 501, { ok: false, error: `${process.platform} has no known file manager` });
        try {
            await launch(command);
        }
        catch (err) {
            console.error("[server] launch failed:", err instanceof Error ? err.message : err);
            return sendJson(res, 502, { ok: false, error: mode === "reveal" ? "could not open the file manager" : "could not open the report" });
        }
        return sendJson(res, 200, { ok: true });
    }
    // Source text plus per-line hits for one file in the loaded report.
    function handleSource(url, res) {
        const u = new URL(url, "http://localhost");
        const path = u.searchParams.get("file") || "";
        if (!coverage)
            return sendJson(res, 404, { ok: false, error: "no coverage loaded" });
        const view = readSourceView(coverage, path);
        if (view === "unknown-file")
            return sendJson(res, 404, { ok: false, error: "no such file in the coverage report" });
        if (view === "no-source")
            return sendJson(res, 404, { ok: false, error: "the file could not be found on this machine" });
        if (view === "unreadable")
            return sendJson(res, 404, { ok: false, error: "the file could not be read" });
        return sendJson(res, 200, { ok: true, ...view });
    }
    // A page cannot set `Host` from JavaScript, so requiring the loopback address
    // this server actually bound is what stops a DNS-rebinding page: it would
    // arrive under its own name, and the browser would then treat our replies --
    // including the token embedded in the page -- as same-origin and readable.
    function fromLoopback(req) {
        const addr = server.address();
        if (!addr)
            return false;
        const allowed = [`127.0.0.1:${addr.port}`, `localhost:${addr.port}`, `[::1]:${addr.port}`];
        if (!allowed.includes(req.headers.host ?? ""))
            return false;
        // Absent on same-origin navigations and on non-browser callers, so it is
        // only meaningful when the caller actually sends one.
        const origin = req.headers.origin;
        return !origin || allowed.some((h) => origin === `http://${h}`);
    }
    const server = createServer(async (req, res) => {
        if (!fromLoopback(req)) {
            res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("forbidden");
            return;
        }
        const url = req.url ?? "";
        if (url === "/events") {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            clients.add(res);
            res.write(`data: ${statePayload()}\n\n`);
            const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
            req.on("close", () => {
                clearInterval(keepAlive);
                clients.delete(res);
            });
            return;
        }
        if (url.startsWith("/files")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ files: selectableFiles(), current: file }));
            return;
        }
        if (url.startsWith("/load")) {
            const u = new URL(url, "http://localhost");
            const name = u.searchParams.get("file") || "";
            // The merged run is listed in the picker under its own name.
            // Re-selecting it while displayed is a no-op; selecting it after
            // drilling into a member rebuilds the merge.
            if (groupDef && name === groupDef.name) {
                // Read before restoring: restoreGroup sets groupName, so asking
                // afterwards would never see that this was a real switch.
                const active = groupName === name;
                const ok = active || restoreGroup(groupDef);
                if (ok && !active)
                    broadcast();
                res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
                res.end(JSON.stringify(ok ? { ok: true, file: name } : { ok: false, error: "no source of that group could be read" }));
                return;
            }
            const abs = resolveResultPath(name, discovered);
            if (!abs) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "unknown file" }));
                return;
            }
            loadSingle(abs, name);
            broadcast();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, file: name }));
            return;
        }
        if (url === "/ask" || url.startsWith("/ask?")) {
            await handleAsk(req, res);
            return;
        }
        if (url === "/ask-coverage" || url.startsWith("/ask-coverage?")) {
            await handleAskCoverage(req, res);
            return;
        }
        if (url === "/ask-impact" || url.startsWith("/ask-impact?")) {
            await handleAskImpact(req, res);
            return;
        }
        if (url.startsWith("/source")) {
            handleSource(url, res);
            return;
        }
        if (url === "/reveal" || url.startsWith("/reveal?")) {
            await handleReveal(req, res);
            return;
        }
        if (url === "/client.js" || url.startsWith("/client.js?")) {
            try {
                const js = readFileSync(CLIENT_BUNDLE);
                res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
                res.end(js);
            }
            catch {
                res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("client bundle not found — run `npm run build`");
            }
            return;
        }
        try {
            const html = await renderShell(title, askToken);
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(html);
        }
        catch (err) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(`View error:\n${err instanceof Error ? err.stack : String(err)}`);
        }
    });
    // Prefer the requested port for a stable URL; fall back to an ephemeral one.
    const boundPort = await new Promise((resolve) => {
        const addr = () => server.address().port;
        const onError = () => {
            server.removeListener("error", onError);
            server.listen(0, "127.0.0.1", () => resolve(addr()));
        };
        server.once("error", onError);
        server.listen(port || 0, "127.0.0.1", () => {
            server.removeListener("error", onError);
            resolve(addr());
        });
    });
    return {
        server,
        url: `http://127.0.0.1:${boundPort}/`,
        port: boundPort,
        // Exposed so tests can post to /ask without scraping it out of the HTML.
        askToken,
        currentFile: () => file,
        revealTarget,
        getResults: () => results,
        setResults(list) {
            const denied = denyWrite();
            if (denied)
                return denied;
            applyResults((list || []).map((t) => ({ name: t.name, status: normalizeStatus(t.status), durationMs: t.durationMs, message: t.message })), null);
            persist(results, file, discovered);
            broadcast();
            return { ok: true, total: results.length };
        },
        addResult(t) {
            const denied = denyWrite();
            if (denied)
                return denied;
            results.push({ name: t.name, status: normalizeStatus(t.status), durationMs: t.durationMs, message: t.message });
            // Extending the run, not replacing it: baseline and agent tags hold.
            retag();
            persist(results, file, discovered);
            broadcast();
            return { ok: true, total: results.length };
        },
        clearResults() {
            const denied = denyWrite();
            if (denied)
                return denied;
            applyResults([], null);
            persist(results, file, discovered);
            broadcast();
            return { ok: true, total: 0 };
        },
        loadNamed(name) {
            if (groupDef && name === groupDef.name) {
                if (groupName === name)
                    return true;
                if (!restoreGroup(groupDef))
                    return false;
                broadcast();
                return true;
            }
            const abs = resolveResultPath(name, discovered);
            if (!abs)
                return false;
            loadSingle(abs, name);
            broadcast();
            return true;
        },
        // Merge a named set of results files into one run — the openFiles(name,
        // files) shape. Returns per-source counts so the caller can verify the
        // merge instead of trusting it.
        openFiles(input) {
            const built = collectSources(input.files ?? []);
            if (!built.entries.length) {
                return { ok: false, error: "none of those paths could be read as a test-results file", skipped: built.skipped };
            }
            const name = groupNameFor(input.name, built.entries.length);
            applySources(built.entries, name);
            // Resolved to a single file, so this is an ordinary run, not a merge:
            // any group left from an earlier open must not stay in the picker.
            if (!name)
                groupDef = null;
            if (!explicitCoverage)
                attachCoverageForSources();
            broadcast();
            return {
                ok: true,
                total: results.length,
                sources: entries.map((e) => ({ label: e.source.label, count: e.source.count })),
                skipped: built.skipped,
            };
        },
        // Re-seed from fresh open input (e.g. a re-open pointing at a new file).
        loadInput(input = {}) {
            const abs = seed(input);
            // An explicit coverage report can resolve even when no results file
            // does, and a new project root re-resolves the report on screen.
            if (abs || input.coverageFile || input.coverageDir || input.projectRoot)
                broadcast();
            return abs;
        },
        // Coverage accessors, mirroring the results ones above.
        getCoverage: () => coverage?.payload ?? null,
        coveragePath: () => coverage?.path ?? null,
        coverageError: () => coverageError,
        projectRoot: () => projectRoot,
        // --- Diff mode ---
        // set_impacted_tests: the agent read the diff and named these tests.
        // Stored by identity so the answer survives the re-run it leads to;
        // unmatched names are reported back.
        markImpacted(refs) {
            const { tags, unmatched } = matchAgentTests(results, refs);
            const next = agentImpact ?? new Map();
            for (const [i, reason] of tags)
                next.set(rowIdentity(results[i]), reason);
            agentImpact = next.size ? next : null;
            retag();
            broadcast();
            return { matched: tags.size, unmatched };
        },
        clearImpacted() {
            agentImpact = null;
            retag();
            broadcast();
        },
        loadCoverage(path) {
            // A caller naming a file directly: it replaces whatever the panel
            // was showing, and is remembered like any other named report.
            const p = resolvePath(path);
            explicitCoverageInput = { coverageFile: p };
            explicitCoverageFor = resultsTarget;
            const ok = requestCoverage({ kind: "file", path: p });
            // Broadcast either way: a failure is part of the state the panel
            // renders, not just a return value for the caller.
            broadcast();
            return ok;
        },
        broadcast,
        reload,
        async close() {
            stopWatchers();
            stopCoverageWatcher();
            stopCoveragePoll();
            for (const res of clients) {
                try {
                    res.end();
                }
                catch { /* ignore */ }
            }
            clients.clear();
            const closed = new Promise((r) => server.close(() => r()));
            // Force-close open SSE connections so the server can finish closing.
            server.closeAllConnections?.();
            await closed;
        },
    };
}
//# sourceMappingURL=server.js.map