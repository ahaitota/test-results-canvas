// SDK-free HTTP server for the Test Results canvas: serves the view, streams
// updates over SSE, loads TRX/JUnit files, and watches the results directory.
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, basename, resolve as resolvePath } from "node:path";
import { watch, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { serializeTrx, parseTrx } from "./parsers/trx.js";
import { parseJUnit } from "./parsers/junit.js";
import { labelForPath } from "./labels.js";
import { composeAskPrompt, composeCoveragePrompt, composePatchCoveragePrompt, composeEnableCoveragePrompt } from "./ask.js";
import { loadCoverageFile, discoverCoverageFor, newestCoverageFileIn, findProjectRoot, suggestCoverageCommand, readSourceView, hasCoverageExt, } from "./coverage/index.js";
import { randomBytes } from "node:crypto";
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
            if (st.isFile() && st.mtimeMs > bestMtime && looksLikeResults(readFileSync(abs, "utf8"))) {
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
export async function createResultsServer(options = {}) {
    // watch=false disables the results-dir watcher.
    const { resultsFile, resultsDir, title = "Test Results", port = 0, watch: watchEnabled = true, onAsk } = options;
    const coverageEnabled = options.coverage !== false;
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
    let watcher = null;
    // Held at this level so closing the server can cancel a reload that was
    // already queued.
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
    let resultsTarget = null;
    const loadOptions = () => ({
        projectRoot,
        skipGit: options.gitExec === null,
        diff: options.gitExec ? { exec: options.gitExec } : undefined,
    });
    function refreshCoverageHint() {
        coverageHint = coverageEnabled ? suggestCoverageCommand(projectRoot, resultsAbsPath ?? undefined) : null;
    }
    function statePayload() {
        return JSON.stringify({
            title,
            results,
            file,
            files: listResultFiles(discovered),
            coverage: coverage ? { ...coverage.payload, revision: coverageRevision } : null,
            coverageHint,
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
    function stopWatcher() {
        for (const t of resultsTimers.values())
            clearTimeout(t);
        resultsTimers.clear();
        if (!watcher)
            return;
        try {
            watcher.close();
        }
        catch { /* already closed */ }
        watcher = null;
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
    // poll share it, so whichever notices a write first does the reading.
    function coverageMoved() {
        const t = coverageTarget;
        if (!t)
            return false;
        return !coverage || stampOf(coveragePathOf(t)) !== coverageStamp;
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
            coverageStamp = null;
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
    function refreshFromDir(dir) {
        const abs = newestResultsFileIn(dir);
        if (!abs)
            return;
        const label = labelForPath(abs, discovered, listLocalNames());
        discovered.set(label, abs);
        file = label;
        results = loadFile(label, discovered);
        // Re-derive so a moved report (dotnet's per-run guid folder) is picked
        // up rather than going stale.
        attachCoverage(abs);
        broadcast();
    }
    function watchDir(dir) {
        stopWatcher();
        try {
            watcher = watch(dir, { persistent: false }, (_event, filename) => {
                if (!filename)
                    return;
                const name = String(filename);
                if (!RESULT_EXTS.some((e) => name.toLowerCase().endsWith(e)))
                    return;
                const abs = resolvePath(dir, name);
                clearTimeout(resultsTimers.get(abs));
                resultsTimers.set(abs, setTimeout(() => {
                    resultsTimers.delete(abs);
                    refreshFromDir(dir);
                }, 400));
            });
            watcher.on("error", (err) => console.error("[server] watcher error:", err?.message || err));
        }
        catch (err) {
            console.error(`[server] watch failed for ${dir}:`, err instanceof Error ? err.message : err);
        }
    }
    // Seed from an explicit file or the newest file in a directory.
    function seed(input) {
        let abs = null;
        if (input.resultsFile) {
            const p = resolvePath(String(input.resultsFile));
            try {
                if (existsSync(p) && statSync(p).isFile() && looksLikeResults(readFileSync(p, "utf8")))
                    abs = p;
            }
            catch { /* unreadable */ }
        }
        if (!abs && input.resultsDir) {
            const d = resolvePath(String(input.resultsDir));
            if (existsSync(d))
                abs = newestResultsFileIn(d);
        }
        // Honoured even when no results file resolved: the agent may be pointing
        // the panel at coverage for a run whose report it could not find.
        const explicitCoverage = seedCoverage(input, abs);
        if (!abs)
            return null;
        const label = labelForPath(abs, discovered, listLocalNames());
        discovered.set(label, abs);
        file = label;
        results = loadFile(label, discovered);
        if (watchEnabled)
            watchDir(dirname(abs));
        if (!explicitCoverage)
            attachCoverage(abs);
        return abs;
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
    if (!seed({ resultsFile, resultsDir, coverageFile: options.coverageFile, coverageDir: options.coverageDir })) {
        results = loadFile(file, discovered);
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
            res.end(JSON.stringify({ files: listResultFiles(discovered), current: file }));
            return;
        }
        if (url.startsWith("/load")) {
            const u = new URL(url, "http://localhost");
            const name = u.searchParams.get("file") || "";
            const abs = resolveResultPath(name, discovered);
            if (!abs) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "unknown file" }));
                return;
            }
            file = name;
            results = loadFile(name, discovered);
            // Picking a different run means a different coverage report.
            attachCoverage(abs);
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
        if (url.startsWith("/source")) {
            handleSource(url, res);
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
        getResults: () => results,
        setResults(list) {
            results = (list || []).map((t) => ({ name: t.name, status: normalizeStatus(t.status), durationMs: t.durationMs, message: t.message }));
            persist(results, file, discovered);
            broadcast();
            return results.length;
        },
        addResult(t) {
            results.push({ name: t.name, status: normalizeStatus(t.status), durationMs: t.durationMs, message: t.message });
            persist(results, file, discovered);
            broadcast();
            return results.length;
        },
        clearResults() {
            results = [];
            persist(results, file, discovered);
            broadcast();
        },
        loadNamed(name) {
            const abs = resolveResultPath(name, discovered);
            if (!abs)
                return false;
            file = name;
            results = loadFile(name, discovered);
            attachCoverage(abs);
            broadcast();
            return true;
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
            stopWatcher();
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