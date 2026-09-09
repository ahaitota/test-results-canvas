// SDK-free HTTP server for the Test Results canvas: serves the view, streams
// updates over SSE, loads TRX/JUnit files, and watches the results directory.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FSWatcher } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, basename, relative, isAbsolute, resolve as resolvePath } from "node:path";
import { watch, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { serializeTrx } from "./parsers/trx.js";
import { looksLikeResults, parseResultsAt, runKey, canonicalPath, canonicalResultPaths, expandsDirectory, formatIdAt, RESULT_EXTS } from "./parsers/registry.js";
import { labelForPath } from "./labels.js";
import { mergeSources } from "./sources.js";
import type { Source } from "./sources.js";
import { readHead } from "./head.js";
import { composeAskPrompt, composeCoveragePrompt, composePatchCoveragePrompt, composeEnableCoveragePrompt, composeImpactPrompt } from "./ask.js";
import { computeRelevance, identitiesOf, matchAgentTests } from "./diff/relevance.js";
import type { AgentTestRef } from "./diff/relevance.js";
import type { DiffPayload } from "./diff/payload.js";
import { rowIdentity } from "./rowkey.js";
import {
    loadCoverageFile,
    discoverCoverageFor,
    newestCoverageFileIn,
    findProjectRoot,
    suggestCoverageCommand,
    readSourceView,
    hasCoverageExt,
    changedLines,
    isGeneratedPath,
} from "./coverage/index.js";
import type { LoadedCoverage, CoverageSuggestion, CoverageLoadFailure, GitExec, DiffResult } from "./coverage/index.js";
import { launchFor, commonParent } from "./reveal.js";
import type { Launch, RevealTarget } from "./reveal.js";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { TestResult, TestStatus } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VIEW_PATH = join(__dirname, "view.js");
const CLIENT_BUNDLE = join(__dirname, "..", "client", "app.js");

// Re-imported only when view.js actually changes, so edits show up on a canvas
// refresh without leaking one cached ESM module per request.
let viewModule: typeof import("./view.js") | undefined;
let viewMtimeMs = -1;
async function renderShell(title: string, askToken: string): Promise<string> {
    const mtimeMs = statSync(VIEW_PATH).mtimeMs;
    if (!viewModule || mtimeMs !== viewMtimeMs) {
        viewModule = (await import(`${pathToFileURL(VIEW_PATH).href}?t=${mtimeMs}`)) as typeof import("./view.js");
        viewMtimeMs = mtimeMs;
    }
    return viewModule.renderShell(title, askToken);
}

// Walk up to the folder that owns package.json so bundled samples and local
// report files resolve the same whether this runs compiled (dist/src) or straight
// from source (src) — e.g. the e2e suite loads the compiled dist copy.
function findExtensionRoot(start: string): string {
    let dir = start;
    while (!existsSync(join(dir, "package.json"))) {
        const parent = dirname(dir);
        if (parent === dir) return start;
        dir = parent;
    }
    return dir;
}
const EXTENSION_ROOT = findExtensionRoot(__dirname);
const SAMPLES_DIR = join(EXTENSION_ROOT, "samples");
const DEFAULT_FILE = "results.trx";

// Re-exported so the extension entry point keeps one import site for what counts
// as a results file.
export { RESULT_EXTS, looksLikeResults };

// Results files directly inside a directory (non-recursive), newest first and
// then by path, so the order is stable across runs. Optionally narrowed to the
// ones a caller can use. Head detection only: whether a candidate parses in
// full is for the caller to find out, since that costs reading it whole.
export function resultsFilesIn(dir: string, accept?: (abs: string) => boolean): string[] {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    const found: { path: string; mtimeMs: number }[] = [];
    for (const n of names) {
        if (!RESULT_EXTS.some((e) => n.toLowerCase().endsWith(e))) continue;
        const abs = resolvePath(dir, n);
        try {
            const st = statSync(abs);
            if (!st.isFile() || !looksLikeResults(readHead(abs))) continue;
            if (accept && !accept(abs)) continue;
            found.push({ path: abs, mtimeMs: st.mtimeMs });
        } catch { /* ignore unreadable */ }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path)).map((f) => f.path);
}

// Newest results file directly inside a directory, or null.
export function newestResultsFileIn(dir: string, accept?: (abs: string) => boolean): string | null {
    return resultsFilesIn(dir, accept)[0] ?? null;
}

export function normalizeStatus(raw: unknown): TestStatus {
    const s = String(raw || "").toLowerCase();
    if (s === "pass" || s === "passed" || s === "ok" || s === "success") return "pass";
    if (s === "fail" || s === "failed" || s === "error") return "fail";
    return "skip";
}

// Reports sitting in the extension folder itself. Content-checked, not just
// name-checked: the formats now include .json, and the extension folder holds a
// package.json that must never reach the picker.
function listLocalNames(): string[] {
    try {
        return readdirSync(EXTENSION_ROOT)
            .filter((f) => RESULT_EXTS.some((e) => f.toLowerCase().endsWith(e)))
            .filter((f) => {
                try {
                    return looksLikeResults(readHead(join(EXTENSION_ROOT, f)));
                } catch {
                    return false;
                }
            })
            .sort();
    } catch {
        return [];
    }
}

// Selectable files = local extension-folder reports + discovered project files.
function listResultFiles(discovered: Map<string, string>): string[] {
    const local = listLocalNames();
    const extras = [...discovered.keys()].filter((l) => !local.includes(l)).sort();
    return [...local, ...extras];
}

// Resolve a picker name to a safe absolute path (discovered label or a basename
// inside the extension folder — no path traversal). null if missing/unsupported.
function resolveResultPath(name: unknown, discovered: Map<string, string>): string | null {
    const raw = String(name || "");
    if (discovered.has(raw)) {
        const abs = discovered.get(raw)!;
        return existsSync(abs) ? abs : null;
    }
    const base = basename(raw);
    if (!RESULT_EXTS.some((e) => base.toLowerCase().endsWith(e))) return null;
    const full = join(EXTENSION_ROOT, base);
    return existsSync(full) ? full : null;
}

// Parse a named file, letting the registry pick the format from its content.
function loadFile(name: string, discovered: Map<string, string>): TestResult[] {
    const full = resolveResultPath(name, discovered);
    return (full && parseResultsAt(full)) || [];
}

// One file in the active set, with its parsed rows cached so a change re-parses
// only the file that changed and the merge is rebuilt from memory.
interface SourceEntry {
    source: Source;
    rows: TestResult[];
    // Set when the format reads the source's whole folder (Allure), so the
    // watcher knows a brand-new sibling is a change to this entry.
    expands: boolean;
    // The format it was read as, remembered so a re-derive can stay on that
    // kind of report even once the file it was read from is gone.
    format?: string;
    // The canonical identity of `source.path`, taken while the file was there
    // to resolve. Watcher events carry whatever spelling the writer used, which
    // need not be the one the source was opened with.
    key?: string;
    // Resolved by asking a directory for its newest report, rather than named.
    // The folder is then the identity, so it follows whatever report in it is
    // newest and readable -- a named source keeps the format it was opened as.
    dirSourced?: boolean;
}

// A path the caller named that did not become a source, and why.
export interface SkippedPath {
    path: string;
    reason: string;
}

// Persist results as TRX, but only for writable local .trx files (never a
// discovered project file — that's the agent's own output).
function persist(results: TestResult[], name: string, discovered: Map<string, string>): void {
    if (discovered.has(String(name || ""))) return;
    const base = basename(String(name || DEFAULT_FILE)) || DEFAULT_FILE;
    if (!base.toLowerCase().endsWith(".trx")) return;
    try {
        writeFileSync(join(EXTENSION_ROOT, base), serializeTrx(results, { runName: "Test Results" }), "utf8");
    } catch (err) {
        console.error("[server] failed to write TRX:", err instanceof Error ? err.message : err);
    }
}

function registerSamples(discovered: Map<string, string>): void {
    try {
        for (const f of readdirSync(SAMPLES_DIR)) {
            if (RESULT_EXTS.some((e) => f.toLowerCase().endsWith(e))) discovered.set(f, join(SAMPLES_DIR, f));
        }
    } catch { /* no samples bundled */ }
}

// Hand the run to the desktop shell. Detached and argv-based: no shell parses
// the path, and the launched app outlives this server. Exit codes are ignored on
// purpose (explorer.exe reports failure on success); only a failure to spawn --
// no opener installed -- is an error.
//
// `windowsHide` must stay off: it reaches the child as SW_HIDE in its
// STARTUPINFO, and Explorer applies that to the folder window it opens, which
// then exists but is invisible.
function spawnLaunch({ command, args, verbatim }: Launch): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: verbatim });
        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}

export interface ResultsServerOptions {
    resultsFile?: string;
    resultsDir?: string;
    // Several results files merged into one run, for repos whose test suite
    // writes one report per project rather than a single file.
    resultsFiles?: readonly string[];
    // Display name for a merged run.
    name?: string;
    // Explicit coverage report. When absent, one is discovered next to the
    // results file (see coverage/discover.ts).
    coverageFile?: string;
    // Folder to take the newest coverage report from.
    coverageDir?: string;
    // The repository or package the report describes. When absent it is
    // inferred from the results file, which is a guess; the agent knows.
    projectRoot?: string;
    title?: string;
    port?: number;
    watch?: boolean;
    alsoRegister?: string[];
    // Turn off coverage discovery entirely.
    coverage?: boolean;
    // Injected for tests; `null` disables the changed-lines section outright.
    gitExec?: GitExec | null;
    // Injected rather than imported so this module stays host-free: the
    // extension passes a closure over session.send, tests pass a spy.
    onAsk?: (req: AskRequest) => void | Promise<void>;
    // Injected for the same reason: tests record the command instead of
    // launching a real file manager.
    launch?: (launch: Launch) => void | Promise<void>;
}

// What POST /ask hands to the host once the row has been resolved server-side.
// Exactly one of `test` and `coverage` is present.
export interface AskRequest {
    prompt: string;
    test?: TestResult;
    coverage?: { scope: "file" | "patch" | "enable"; path?: string };
    // Raised from diff mode: "which tests does this change affect?".
    diff?: { scope: "impact" };
}

// A single result as accepted from SDK actions before its status is normalized.
export interface ResultInput {
    name: string;
    status: unknown;
    durationMs?: number;
    message?: string;
}

// The optional file/folder pointers a canvas open (or re-open) can carry.
// `resultsFiles` is the merged form — several test projects presented as one
// run; the singular fields are the original one-file API and are used only when
// that list resolves nothing.
export interface SeedInput {
    name?: string;
    resultsFile?: string;
    resultsDir?: string;
    resultsFiles?: readonly string[];
    coverageFile?: string;
    coverageDir?: string;
    projectRoot?: string;
}

// What openFiles() reports back, so the agent gets a verifiable receipt instead
// of a silent partial merge.
export interface OpenFilesResult {
    ok: boolean;
    error?: string;
    total?: number;
    sources?: { label: string; count: number }[];
    skipped: SkippedPath[];
}

// Refusal shape shared by the mutating actions, so a blocked write reads as a
// message rather than as a silently ignored call.
export interface WriteResult {
    ok: boolean;
    total?: number;
    error?: string;
}

// The handle returned by createResultsServer; the type the SDK glue stores per canvas.
export type ResultsServerHandle = Awaited<ReturnType<typeof createResultsServer>>;

// A file or a folder the panel follows.
//
//   file -- exactly that path, and nothing else appearing beside it.
//   dir  -- whichever qualifying file in the folder is newest, so a re-run
//           writing under a different name still lands.
type PathTarget =
    | { kind: "file"; path: string }
    | { kind: "dir"; dir: string };

export async function createResultsServer(options: ResultsServerOptions = {}) {
    // watch=false disables the results-dir watcher.
    const { resultsFile, resultsDir, title = "Test Results", port = 0, watch: watchEnabled = true, onAsk } = options;
    const coverageEnabled = options.coverage !== false;
    const launch = options.launch ?? spawnLaunch;

    // The server listens on a fixed, guessable port, so /ask -- which can drive
    // the user's agent -- is gated on a secret minted per instance and handed
    // only to the page this server rendered.
    const askToken = randomBytes(16).toString("hex");

    const discovered = new Map<string, string>();
    registerSamples(discovered);
    for (const p of options.alsoRegister || []) {
        try {
            const abs = resolvePath(String(p));
            if (existsSync(abs)) discovered.set(labelForPath(abs, discovered, listLocalNames()), abs);
        } catch { /* ignore */ }
    }

    const clients = new Set<ServerResponse>();
    let file = DEFAULT_FILE;
    let results: TestResult[] = [];

    // The active source set. One entry is the classic single-file case; several
    // is a merged run. Empty means nothing was seeded, and `results` is then
    // owned directly by the report/clear actions.
    let entries: SourceEntry[] = [];
    // The display name of a merged run, or null when a single file is loaded.
    let groupName: string | null = null;
    // The group that was opened, remembered independently of what is displayed:
    // picking one member out of the picker switches the view, and must not
    // destroy the only way back to the merge.
    let groupDef: { name: string; paths: string[] } | null = null;
    // One watcher per directory the sources live in, with the identity of the
    // directory each was armed on -- a folder deleted and recreated keeps the
    // old watcher alive but silent, and the stamp is how that is noticed.
    const watchers = new Map<string, FSWatcher>();
    const watchStamps = new Map<string, string>();
    // Verifies those watchers, and arms one for a folder that did not exist
    // when the panel opened.
    let resultsPoll: ReturnType<typeof setInterval> | null = null;
    // Held at this level so closing the server can cancel a reload that was
    // already queued. Keyed by watched folder, alongside the file names that
    // changed in it since the last refresh.
    const resultsTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const pendingNames = new Map<string, Set<string>>();
    // What the caller asked to open when nothing usable was there yet -- a run
    // still being written, most often. Its folders are watched so the report
    // arrives on its own instead of needing the panel reopened. One at a time:
    // a fresh seed replaces the intent, as it replaces the view.
    let awaitedSeed:
        | { kind: "file"; dir: string; name: string }
        | { kind: "dir"; dir: string }
        | { kind: "group"; name?: string; paths: string[] }
        | null = null;

    // `coverageWatcher` follows the report's folder so a re-run refreshes the
    // panel the same way results already do.
    let coverage: LoadedCoverage | null = null;
    let coverageWatcher: FSWatcher | null = null;
    // What the panel has been asked to show, kept apart from what it managed to
    // load. Requests outlive their failures: a report named before the run that
    // writes it does not exist yet, and that is normal rather than an error.
    let coverageTarget: PathTarget | null = null;
    let coverageWatchDir: string | null = null;
    // Identity of the report on screen, so disk can be compared against it
    // without re-reading it.
    let coverageStamp: string | null = null;
    let coverageRevision = 0;
    // Looks for what the watcher cannot see. Runs while there is a request.
    let coveragePoll: ReturnType<typeof setInterval> | null = null;
    let coverageTimer: ReturnType<typeof setTimeout> | null = null;
    // Bumped every time the watcher is retired, so a callback already queued
    // against the old folder cannot resurrect the report it belonged to.
    let coverageWatchGeneration = 0;
    let projectRoot: string | undefined;
    // A root the caller named. Inference must never overwrite it: the agent ran
    // the command and knows which package the report belongs to.
    let explicitProjectRoot: string | undefined = options.projectRoot ? resolvePath(String(options.projectRoot)) : undefined;
    if (explicitProjectRoot) projectRoot = explicitProjectRoot;
    let coverageHint: CoverageSuggestion | null = null;
    // Set when a report was found but could not be used, so the empty state can
    // say why instead of implying no coverage was collected.
    let coverageError: CoverageLoadFailure | null = null;
    // A report the caller named, and the run it was named for: an explicit
    // report belongs to that run, not to whatever run is loaded next. Null
    // means "named before any run was known".
    let explicitCoverageInput: SeedInput | null = null;
    let explicitCoverageFor: PathTarget | null = null;
    // The run on screen. A panel opened on a folder keeps the same run as it
    // re-runs, under whatever name each writes.
    let resultsAbsPath: string | null = null;
    // Set when the caller named a coverage report outright, so a results refresh
    // never re-discovers over the top of an explicit choice.
    let explicitCoverage = false;
    let resultsTarget: PathTarget | null = null;

    // --- Diff mode (issue #8) ---
    //
    // `baseline`: identities of the previous run, so a test appearing out of
    // nowhere is new. Carried across only when the *same* file reloads.
    // `agentImpact`: keyed by identity, not index, so the agent's answer
    // survives the re-run it usually triggers.
    let diff: DiffPayload | null = null;
    let baseline: Set<string> | null = null;
    let agentImpact: Map<string, string> | null = null;
    // The raw diff behind `diff`. Off the wire, but the impact prompt uses it.
    let lastChanges: DiffResult | null = null;
    // Tracked separately from resultsAbsPath, which only exists with coverage on.
    let loadedResultsPath: string | null = null;

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
    function agentIndexes(): Map<number, string> | null {
        if (!agentImpact?.size) return null;
        const out = new Map<number, string>();
        for (let i = 0; i < results.length; i++) {
            const reason = agentImpact.get(rowIdentity(results[i]));
            if (reason) out.set(i, reason);
        }
        return out.size ? out : null;
    }

    // Re-tag the loaded run from the diff already read. Cheap: no subprocess.
    function retag(): void {
        diff = computeRelevance({ results, baseline, changes: lastChanges, agent: agentIndexes() });
    }

    // Ask git what changed, then re-tag. Once per results load, never per row.
    function refreshDiff(): void {
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
    function applyResults(next: TestResult[], fromPath: string | null): void {
        const continues = Boolean(fromPath) && fromPath === loadedResultsPath;
        baseline = continues && results.length ? identitiesOf(results) : null;
        // The agent's conclusions were about the run that just went away.
        if (!continues) agentImpact = null;
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
        for (const res of clients) res.write(`data: ${statePayload()}\n\n`);
    }
    function reload() {
        for (const res of clients) res.write(`event: reload\ndata: 1\n\n`);
    }

    function stopWatchers(): void {
        // Timers first: a reload already queued must not fire against a folder
        // this server has stopped watching.
        for (const t of resultsTimers.values()) clearTimeout(t);
        resultsTimers.clear();
        pendingNames.clear();
        if (resultsPoll) {
            clearInterval(resultsPoll);
            resultsPoll = null;
        }
        for (const w of watchers.values()) {
            try {
                w.close();
            } catch { /* already closed */ }
        }
        watchers.clear();
        watchStamps.clear();
    }
    function stopCoverageWatcher() {
        // Retire the current generation first: a debounced callback that has
        // already been queued must not act on the folder we are leaving.
        coverageWatchGeneration++;
        if (coverageTimer) {
            clearTimeout(coverageTimer);
            coverageTimer = null;
        }
        if (!coverageWatcher) return;
        try {
            coverageWatcher.close();
        } catch { /* already closed */ }
        coverageWatcher = null;
        coverageWatchDir = null;
    }

    // --- Coverage loading ---

    // Forget the request and everything that came of it. Used when the run
    // changes: whatever comes next belongs to a different run.
    function clearCoverage(): void {
        coverage = null;
        coverageError = null;
        coverageTarget = null;
        coverageStamp = null;
        armCoverageWatch();
    }

    function targetDir(t: PathTarget): string {
        return t.kind === "file" ? dirname(t.path) : t.dir;
    }

    function targetHolds(t: PathTarget, path: string): boolean {
        return t.kind === "file" ? t.path === path : dirname(path) === t.dir;
    }

    function coveragePathOf(t: PathTarget): string | null {
        return t.kind === "file" ? t.path : (existsSync(t.dir) ? newestCoverageFileIn(t.dir) : null);
    }

    // Enough of a file to notice it being rewritten without reading it.
    function stampOf(path: string | null): string | null {
        if (!path) return null;
        try {
            const s = statSync(path);
            return `${path}:${s.mtimeMs}:${s.size}`;
        } catch {
            return null;
        }
    }

    // Keep a watcher on the folder holding the report on screen, so its next
    // rewrite shows up at once. The watcher is a shortcut for the common case,
    // not the source of truth -- `syncCoveragePoll` is what guarantees a change
    // is noticed.
    function armCoverageWatch(): void {
        const t = coverageTarget;
        if (coverage && t && watchEnabled) {
            const dir = targetDir(t);
            if (dir !== coverageWatchDir) watchCoverageDir(dir);
        } else {
            stopCoverageWatcher();
        }
        syncCoveragePoll();
    }

    // Compare disk against the panel for as long as there is a request to
    // answer. A directory watcher cannot carry this alone: the folder may not
    // exist yet, may be built a level at a time, and may be swapped out without
    // an event arriving. A tick costs a stat.
    function syncCoveragePoll(): void {
        const wanted = watchEnabled && coverageTarget !== null;
        if (wanted === (coveragePoll !== null)) return;
        if (!wanted) return stopCoveragePoll();
        coveragePoll = setInterval(() => {
            if (coverageMoved() && settleCoverage()) broadcast();
        }, 500);
        coveragePoll.unref?.();
    }

    // Whether disk still says what the panel is showing. The watcher and the
    // poll share it, so whichever notices a write first does the reading. A
    // failed target is stamped like any other, so a file that cannot be read is
    // not read again until it changes; a missing one stamps as null and is
    // picked up the moment it appears.
    function coverageMoved(): boolean {
        const t = coverageTarget;
        if (!t) return false;
        return stampOf(coveragePathOf(t)) !== coverageStamp;
    }

    function stopCoveragePoll(): void {
        if (!coveragePoll) return;
        clearInterval(coveragePoll);
        coveragePoll = null;
    }

    // Read the target again and put the watcher and the poll where they belong.
    // Returns whether anything the panel shows changed.
    function settleCoverage(): boolean {
        if (!coverageTarget) return false;
        const changed = refreshCoverage();
        armCoverageWatch();
        return changed;
    }

    // Make what the panel shows match what it was asked for, reading from disk.
    // Returns true when clients need telling. A report that has gone bad counts
    // as a change, since the numbers on screen no longer describe anything.
    function refreshCoverage(): boolean {
        const t = coverageTarget;
        if (!t) return false;
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
        if (!projectRoot) projectRoot = loaded.coverage.projectRoot;
        refreshCoverageHint();
        return true;
    }

    // Take on a target a caller named. It becomes the request whether or not it
    // loads, so a failure is what the panel shows, and a target that does not
    // exist yet is waited for.
    function requestCoverage(t: PathTarget): boolean {
        coverageTarget = t;
        settleCoverage();
        return coverage !== null;
    }

    // Try a candidate discovery came up with. Only a guess, so it becomes the
    // request only if it loads. From then on its folder is followed, because a
    // re-run may write the report under a new name.
    function tryCoverage(absPath: string): boolean {
        const loaded = loadCoverageFile(absPath, loadOptions());
        if (!loaded.ok) return false;
        coverage = loaded.coverage;
        coverageError = null;
        coverageTarget = { kind: "dir", dir: dirname(absPath) };
        coverageStamp = stampOf(absPath);
        coverageRevision++;
        if (!projectRoot) projectRoot = loaded.coverage.projectRoot;
        refreshCoverageHint();
        armCoverageWatch();
        return true;
    }

    // Separate from the results watcher because the two files usually live in
    // different folders (`coverage/lcov.info` vs `test-results/junit.xml`).
    function watchCoverageDir(dir: string): void {
        stopCoverageWatcher();
        const generation = coverageWatchGeneration;
        coverageWatchDir = dir;
        try {
            coverageWatcher = watch(dir, { persistent: false }, (_event, filename) => {
                if (generation !== coverageWatchGeneration) return;
                if (!filename || !hasCoverageExt(String(filename))) return;
                if (coverageTimer) clearTimeout(coverageTimer);
                coverageTimer = setTimeout(() => {
                    coverageTimer = null;
                    if (coverageMoved() && settleCoverage()) broadcast();
                }, 400);
            });
            coverageWatcher.on("error", (err) => console.error("[server] coverage watcher error:", err?.message || err));
        } catch (err) {
            console.error(`[server] coverage watch failed for ${dir}:`, err instanceof Error ? err.message : err);
        }
    }

    // Find and load the report that belongs with the results file just loaded.
    // Whatever was loaded before belongs to a different run.
    function attachCoverage(resultsAbs: string | null): void {
        if (!coverageEnabled) return;
        resultsAbsPath = resultsAbs;
        if (resultsAbs && !explicitProjectRoot) projectRoot = findProjectRoot(dirname(resultsAbs));
        clearCoverage();
        refreshCoverageHint();
        if (!resultsAbs) return;

        // A report named for this run outranks anything discovery would guess
        // at. One named for a different run is not reused.
        if (explicitCoverageInput && (explicitCoverageFor === null || targetHolds(explicitCoverageFor, resultsAbs))) {
            seedCoverage(explicitCoverageInput, resultsAbs);
            return;
        }
        explicitCoverageInput = null;
        explicitCoverageFor = null;
        const found = discoverCoverageFor(resultsAbs, projectRoot);
        if (found) tryCoverage(found);
    }

    // Coverage for a merged run is deliberately NOT merged: N test projects
    // write N reports, and stitching them is its own problem. So a report is
    // attached only when exactly one source has one — showing project A's
    // coverage beside A+B+C results would read as coverage for all of it.
    function attachCoverageForSources(): void {
        if (!coverageEnabled) return;
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
        const owns = (resultsPath: string): boolean => {
            const found = discoverCoverageFor(resultsPath);
            if (!found) return false;
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
        if (!explicitProjectRoot) projectRoot = findProjectRoot(dirname(resultsAbsPath));
        refreshCoverageHint();
    }

    // --- The source set ---

    // The merged run appears in the picker under its own name, alongside the
    // individual files. Listed from the group that was opened rather than the
    // one on screen, so drilling into a member leaves a way back.
    function selectableFiles(): string[] {
        const list = listResultFiles(discovered);
        const name = groupDef?.name;
        return name && !list.includes(name) ? [name, ...list] : list;
    }

    // What /reveal acts on. A single run is its file; a merged run has no single
    // file, so it is the folder its sources share. Null when nothing on disk
    // backs the rows on screen -- results the agent reported, or a report
    // deleted since it was loaded.
    function revealTarget(): RevealTarget | null {
        // An action replaces the rows without touching the sources, so the file
        // they came from is no longer what is on screen.
        if (!loadedResultsPath) return null;
        const paths = entries.map((e) => e.source.path);
        if (!paths.length) return null;
        const target: RevealTarget | null = paths.length === 1
            ? { kind: "file", path: paths[0] }
            : (() => {
                const dir = commonParent(paths, process.platform);
                return dir ? { kind: "dir" as const, path: dir } : null;
            })();
        return target && existsSync(target.path) ? target : null;
    }

    function buildEntry(abs: string, dirSourced = false): SourceEntry | null {
        const rows = parseResultsAt(abs);
        if (rows === null) return null;
        const label = labelForPath(abs, discovered, listLocalNames());
        discovered.set(label, abs);
        return { source: { label, path: abs, count: rows.length }, rows, expands: expandsDirectory(abs), format: formatIdAt(abs, "full"), key: canonicalPath(abs), dirSourced };
    }

    // The first of these paths that parses in full. Head detection is not
    // enough to choose by: a report caught mid-write is recognizable long
    // before it is complete, and picking it would hide a finished run sitting
    // beside it.
    //
    // Collapsed to one path per run first: a format that takes in its whole
    // folder re-reads every sibling on each attempt, so walking all of them
    // would parse the directory once per file in it -- and they are the same
    // run, so the second attempt could only fail the same way as the first.
    function firstReadable(candidates: readonly string[], dirSourced = false): SourceEntry | null {
        for (const abs of canonicalResultPaths(candidates)) {
            const entry = buildEntry(abs, dirSourced);
            if (entry) return entry;
        }
        return null;
    }

    // Resolve named files into sources, reporting what fell out so the caller
    // can hand back a receipt rather than a silent partial merge. `unusable`
    // counts only the paths that could not be READ: a path that merely repeats
    // a run another already covers is redundant, not missing, and must not
    // stand in the way of a merge that is otherwise complete.
    function collectSources(files: readonly string[]): { entries: SourceEntry[]; skipped: SkippedPath[]; unusable: number } {
        const built: SourceEntry[] = [];
        const skipped: SkippedPath[] = [];
        const seen = new Set<string>();
        let unusable = 0;
        for (const raw of files) {
            const abs = resolvePath(raw);
            // Keyed by run, not by path: an Allure folder is one source however
            // many of its result files the caller happened to name.
            const key = runKey(abs);
            if (seen.has(key)) {
                skipped.push({ path: raw, reason: "duplicate of another source" });
                continue;
            }
            seen.add(key);
            if (!existsSync(abs)) {
                skipped.push({ path: raw, reason: "no such file" });
                unusable++;
                continue;
            }
            const entry = buildEntry(abs);
            if (!entry) {
                skipped.push({ path: raw, reason: "not a readable test-results file" });
                unusable++;
                continue;
            }
            built.push(entry);
        }
        return { entries: built, skipped, unusable };
    }

    // Swap in a new set and rebuild everything that hangs off it.
    function applySources(list: SourceEntry[], name: string | null): void {
        entries = list;
        groupName = name;
        // Recorded from what actually resolved, so a path that could not be read
        // is not retried on every restore.
        if (name) groupDef = { name, paths: list.map((e) => e.source.path) };
        rebuild();
        if (watchEnabled) syncWatchers();
    }

    function rebuild(): void {
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
        if (entries.length) file = groupName ?? entries[0].source.label;
    }

    // Re-read one source in place. False when nothing usable came back, so a
    // half-written file keeps showing the rows it already had.
    function reparse(entry: SourceEntry, abs: string): boolean {
        const rows = parseResultsAt(abs);
        if (rows === null) return false;
        const label = abs === entry.source.path ? entry.source.label : labelForPath(abs, discovered, listLocalNames());
        if (abs !== entry.source.path) discovered.set(label, abs);
        entry.rows = rows;
        entry.source = { label, path: abs, count: rows.length };
        entry.expands = expandsDirectory(abs);
        entry.format = formatIdAt(abs, "full") ?? entry.format;
        entry.key = canonicalPath(abs);
        return true;
    }

    // Accepts only reports of the format a source was read as, so re-deriving
    // keeps it on the kind of report it started as -- and still works once the
    // file it was read from has been deleted by a re-run.
    function sameFormat(want: string | undefined): (candidate: string) => boolean {
        return (candidate) => want !== undefined && formatIdAt(candidate) === want;
    }

    // The folders an unfulfilled seed is waiting on.
    function awaitedDirs(): string[] {
        if (!awaitedSeed) return [];
        if (awaitedSeed.kind === "group") return [...new Set(awaitedSeed.paths.map((p) => dirname(p)))];
        return [awaitedSeed.dir];
    }

    // The exact file names it is waiting for in `dir`. Those are watched
    // whatever they are called, since a named file is accepted by content.
    function awaitedNamesIn(dir: string): Set<string> {
        if (!awaitedSeed) return new Set();
        if (awaitedSeed.kind === "file") return new Set(awaitedSeed.dir === dir ? [awaitedSeed.name] : []);
        if (awaitedSeed.kind === "group") return new Set(awaitedSeed.paths.filter((p) => dirname(p) === dir).map((p) => basename(p)));
        return new Set();
    }

    // Whether a file this server is following just moved. Compared as canonical
    // paths rather than raw names: Windows reports whichever spelling the
    // writer used, which need not be the one the source was opened with, and a
    // missed event on a report whose extension no scan looks at leaves the
    // panel stuck on what it had.
    function isWatchedFile(dir: string, name: string): boolean {
        const raw = join(dir, name);
        if (entries.some((e) => e.source.path === raw) || awaitedNamesIn(dir).has(name)) return true;
        const key = canonicalPath(raw);
        if (entries.some((e) => (e.key ?? canonicalPath(e.source.path)) === key)) return true;
        for (const awaited of awaitedNamesIn(dir)) {
            if (canonicalPath(join(dir, awaited)) === key) return true;
        }
        return false;
    }

    // Retry an unfulfilled seed after something moved in `dir`. Nothing is shown
    // until the whole request resolves, on the same all-or-nothing terms the
    // original seed applied. True once it has, so the caller stops: what was
    // asked for outranks whatever the panel fell back to.
    function retryAwaitedSeed(dir: string): boolean {
        if (!awaitedSeed || !awaitedDirs().includes(dir)) return false;
        if (awaitedSeed.kind === "group") {
            const built = collectSources(awaitedSeed.paths);
            if (built.unusable || !built.entries.length) return false;
            const name = groupNameFor(awaitedSeed.name, built.entries.length);
            awaitedSeed = null;
            applySources(built.entries, name);
        } else {
            // A directory follows its newest report, but the newest can be one
            // caught mid-write: take the first that parses in full, so a
            // complete older run beats a partial newer one.
            const candidates = awaitedSeed.kind === "file"
                ? [resolvePath(awaitedSeed.dir, awaitedSeed.name)]
                : resultsFilesIn(awaitedSeed.dir);
            const entry = firstReadable(candidates, awaitedSeed.kind === "dir");
            if (!entry) return false;
            awaitedSeed = null;
            applySources([entry], null);
            groupDef = null;
        }
        if (!explicitCoverage) attachCoverageForSources();
        broadcast();
        return true;
    }

    // Only the sources living in `dir` are touched: a five-project group must
    // not re-read four untouched files because the fifth was rewritten.
    function refreshDir(dir: string, changedNames: ReadonlySet<string>): void {
        // A seed that could not be fulfilled when the panel opened gets first
        // refusal on the event, wherever the fallback sources happen to live.
        if (retryAwaitedSeed(dir)) return;
        const here = entries.filter((e) => dirname(e.source.path) === dir);
        if (!here.length) return;
        let changed = false, moved = false;
        // Compared as canonical identities for the same reason the watcher
        // accepts an event at all: the spelling in the event need not be the
        // one the source was opened with.
        const changedKeys = new Set([...changedNames].map((n) => canonicalPath(join(dir, n))));
        const touched = (entry: SourceEntry) => changedKeys.has(entry.key ?? canonicalPath(entry.source.path));
        if (here.length === 1) {
            const entry = here[0];
            const before = entry.source.path;
            // Move the source onto the first candidate that parses, or re-read
            // where it already points when none do. One path per run, for the
            // same reason firstReadable() takes one: a folder-expanding format
            // parses every sibling on each attempt.
            const follow = (candidates: readonly string[]): boolean => {
                for (const candidate of canonicalResultPaths(candidates)) {
                    if (!reparse(entry, candidate)) continue;
                    moved = candidate !== before;
                    return true;
                }
                return reparse(entry, before);
            };
            // The file the source names was itself rewritten: that IS the
            // update. Re-deriving here would hand the panel whatever else in
            // the folder happens to be newer, which is how an explicitly named
            // report gets replaced by an unrelated one beside it.
            const rewritten = touched(entry) && existsSync(before);
            // Otherwise a source alone in its folder follows that folder's
            // newest report: `dotnet test` writes a fresh
            // <machine>_<user>_<timestamp>.trx per run instead of overwriting,
            // and re-deriving is how a single named file has always stayed
            // live. Taken newest-first until one parses, so a report caught
            // mid-write does not shut out the complete one behind it.
            //
            // A source that came from a DIRECTORY follows it wherever it goes,
            // because the folder is what was asked for -- including onto a
            // report of another format, which is a runner writing its results
            // differently, not a different run. A NAMED source keeps the format
            // it was opened as, so a stray report beside it cannot take its
            // place.
            //
            // Sources that SHARE a folder never re-derive at all. They would all
            // resolve onto the same newest file and quietly collapse into one,
            // losing the rest of the merge — so they re-parse their own path.
            if (entry.dirSourced) {
                changed = follow(resultsFilesIn(dir));
            } else if (rewritten) {
                changed = reparse(entry, before);
            } else {
                changed = follow(resultsFilesIn(dir, sameFormat(entry.format)));
            }
        } else {
            for (const entry of here) {
                // A folder-expanding source (Allure) reads every result beside
                // it, so a brand-new sibling changed it even though the file it
                // is named after did not.
                if (!entry.expands && !touched(entry)) continue;
                // It is only ANCHORED on that file, though. A re-run that
                // deletes the old results and writes new ones leaves the anchor
                // pointing at nothing, so follow the folder to a sibling of the
                // same kind rather than going stale on a file that is gone.
                const anchor = entry.expands && !existsSync(entry.source.path)
                    ? newestResultsFileIn(dir, expandsDirectory) ?? entry.source.path
                    : entry.source.path;
                if (reparse(entry, anchor)) changed = true;
            }
        }
        if (!changed) return;
        rebuild();
        // A moved report means the coverage beside it moved too. An explicitly
        // named report is left alone — the caller chose it.
        if (moved && !explicitCoverage) attachCoverageForSources();
        broadcast();
    }

    // Directory identity, so a folder deleted and recreated is not mistaken for
    // the one a watcher is still attached to. Null when it is not there (or is
    // not a directory) at all.
    function dirStamp(dir: string): string | null {
        try {
            const st = statSync(dir);
            return st.isDirectory() ? `${st.ino}:${st.birthtimeMs}` : null;
        } catch {
            return null;
        }
    }

    function dropWatcher(dir: string): void {
        const w = watchers.get(dir);
        if (w) {
            try {
                w.close();
            } catch { /* already closed */ }
        }
        watchers.delete(dir);
        watchStamps.delete(dir);
    }

    function startWatch(dir: string): void {
        const stamp = dirStamp(dir);
        // Not there yet -- a run that has still to create its output folder.
        // The poll arms the watcher the moment it appears.
        if (stamp === null) return;
        try {
            const w = watch(dir, { persistent: false }, (_event, filename) => {
                // Node is allowed to report a change without saying what moved.
                // Dropping it would leave the panel on a run that is no longer
                // what is on disk, so the whole folder is re-read instead.
                if (!filename) {
                    clearTimeout(resultsTimers.get(dir));
                    resultsTimers.set(dir, setTimeout(() => {
                        resultsTimers.delete(dir);
                        pendingNames.delete(dir);
                        rescanDir(dir);
                    }, 400));
                    return;
                }
                const name = String(filename);
                // An active source is watched whatever it is called: an
                // explicitly named file is accepted by content, so a rewrite of
                // `junit.report` must not be discarded for its extension. Same
                // for a file a seed is still waiting for. The filter only bounds
                // what a scan may DISCOVER.
                if (!isWatchedFile(dir, name) && !RESULT_EXTS.some((e) => name.toLowerCase().endsWith(e))) return;
                // Debounced per watched folder, collecting the names that moved
                // in it. Keying by folder rather than by file is what keeps a
                // burst -- an Allure run writes one JSON per test -- to a single
                // refresh, and the key is absolute, so two watched folders that
                // each hold a `results.trx` never cancel one another.
                const pending = pendingNames.get(dir) ?? new Set<string>();
                pendingNames.set(dir, pending);
                pending.add(name);
                clearTimeout(resultsTimers.get(dir));
                resultsTimers.set(dir, setTimeout(() => {
                    resultsTimers.delete(dir);
                    pendingNames.delete(dir);
                    refreshDir(dir, pending);
                }, 400));
            });
            w.on("error", (err) => {
                console.error("[server] watcher error:", err?.message || err);
                // A watcher that has errored delivers nothing further; drop it
                // so the poll puts a working one back.
                dropWatcher(dir);
            });
            watchers.set(dir, w);
            watchStamps.set(dir, stamp);
        } catch (err) {
            console.error(`[server] watch failed for ${dir}:`, err instanceof Error ? err.message : err);
        }
    }

    // Every folder the panel has a reason to watch.
    function wantedDirs(): string[] {
        const wanted = new Set(entries.map((e) => dirname(e.source.path)));
        for (const dir of awaitedDirs()) wanted.add(dir);
        return [...wanted];
    }

    // Re-read a folder from scratch: every source in it is treated as changed,
    // which is what a watcher gap means -- whatever happened while nothing was
    // listening was missed.
    function rescanDir(dir: string): void {
        if (retryAwaitedSeed(dir)) return;
        const here = entries.filter((e) => dirname(e.source.path) === dir);
        if (here.length) refreshDir(dir, new Set(here.map((e) => basename(e.source.path))));
    }

    // The watchers are a shortcut for the common case, not the source of truth.
    // A folder may not exist when the panel opens -- `dotnet test` creates
    // TestResults/ on the first run -- and one deleted and recreated leaves its
    // watcher attached to a directory nothing writes to any more, with no event
    // to say so. A tick costs one stat per watched folder.
    function syncResultsPoll(): void {
        const wanted = watchEnabled && wantedDirs().length > 0;
        if (wanted === (resultsPoll !== null)) return;
        if (!wanted) {
            if (resultsPoll) clearInterval(resultsPoll);
            resultsPoll = null;
            return;
        }
        resultsPoll = setInterval(() => {
            for (const dir of wantedDirs()) {
                const stamp = dirStamp(dir);
                if (stamp === null) {
                    dropWatcher(dir);
                    continue;
                }
                if (watchers.has(dir) && watchStamps.get(dir) === stamp) continue;
                dropWatcher(dir);
                startWatch(dir);
                rescanDir(dir);
            }
        }, 500);
        resultsPoll.unref?.();
    }

    // One watcher per directory the sources live in, plus any an unfulfilled
    // seed is waiting on, recomputed from the active set: several sources in
    // one folder share a watcher, and a folder nothing points at any more is
    // dropped.
    function syncWatchers(): void {
        const wanted = new Set(wantedDirs());
        for (const dir of [...watchers.keys()]) {
            if (!wanted.has(dir)) dropWatcher(dir);
        }
        for (const dir of wanted) if (!watchers.has(dir)) startWatch(dir);
        syncResultsPoll();
    }

    // Seed from a set of files, or from the original single file/dir.
    function seed(input: SeedInput): string | null {
        let loaded = false;
        // A fresh seed re-points the whole panel, so whatever a previous one was
        // still waiting for is no longer wanted.
        awaitedSeed = null;
        const files = input.resultsFiles ?? [];
        if (files.length) {
            const built = collectSources(files);
            // All or nothing. A seed has no receipt to hand back the way the
            // open_files action does, so a partial merge would quietly show
            // fewer tests than were asked for with nothing on screen to say so.
            if (built.unusable || !built.entries.length) {
                if (built.skipped.length) {
                    console.error(`[server] not seeding a partial merge: ${built.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`);
                }
                // The missing half may be a report still being written, so wait
                // for it rather than making the caller reopen the panel.
                awaitedSeed = { kind: "group", name: input.name, paths: files.map((f) => resolvePath(f)) };
            } else {
                applySources(built.entries, groupNameFor(input.name, built.entries.length));
                loaded = true;
            }
        }
        if (!loaded && (input.resultsFile || input.resultsDir)) {
            // isFile, so a folder handed to resultsFile falls through to the
            // resultsDir branch rather than swallowing it; and it has to parse,
            // so something that is not a report -- or is one caught mid-write --
            // falls through too rather than blanking the panel.
            const named = input.resultsFile ? resolvePath(String(input.resultsFile)) : null;
            let entry: SourceEntry | null = null;
            try {
                if (named && existsSync(named) && statSync(named).isFile()) entry = buildEntry(named);
            } catch { /* unreadable */ }
            const dir = input.resultsDir ? resolvePath(String(input.resultsDir)) : null;
            // Newest first, but the newest can be a report caught mid-write, so
            // take the first that parses in full: a complete older run beats a
            // partial newer one.
            if (!entry && dir) entry = firstReadable(resultsFilesIn(dir), true);
            if (entry) {
                applySources([entry], null);
                // A fresh seed re-points the whole panel, so a group left over
                // from a previous open must not stay in the picker.
                groupDef = null;
                loaded = true;
            } else if (!awaitedSeed && dir) {
                awaitedSeed = { kind: "dir", dir };
            } else if (!awaitedSeed && named) {
                awaitedSeed = { kind: "file", dir: dirname(named), name: basename(named) };
            }
        }

        // Honoured even when no results file resolved: the agent may be pointing
        // the panel at coverage for a run whose report it could not find.
        explicitCoverage = seedCoverage(input, entries[0]?.source.path ?? null);
        if (!loaded) {
            // applySources does this for a seed that landed; one still waiting
            // has to start its own watchers.
            if (watchEnabled) syncWatchers();
            return null;
        }
        if (!explicitCoverage) attachCoverageForSources();
        return entries[0].source.path;
    }

    // One source is never a group, however it was opened and whatever the caller
    // called it: there is nothing to group by, so a name would only buy the UI a
    // File grouping that buckets every row under "(no file)".
    function groupNameFor(name: string | undefined, count: number): string | null {
        return count > 1 ? (name || "Merged results") : null;
    }

    // Load one file on its own, leaving any merged run behind — picking a file
    // outside it is a deliberate departure. `label` is the picker name chosen,
    // which is what the <select> expects to see back. `groupDef` survives, so
    // the merge stays listed and can be picked again.
    function loadSingle(abs: string, label: string): void {
        // A deliberate choice retires whatever an unfulfilled seed was still
        // waiting for: it must not arrive later and take the panel back.
        awaitedSeed = null;
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
    function restoreGroup(def: { name: string; paths: string[] }): boolean {
        const built = collectSources(def.paths);
        // A member deleted since the group was opened drops out; the rest still
        // merge, and the per-source counts in the header show what came back.
        if (!built.entries.length) return false;
        // Decayed to one readable file, it is no longer a merge — but `groupDef`
        // stays, because the group still exists and the member may return.
        applySources(built.entries, groupNameFor(def.name, built.entries.length));
        if (!explicitCoverage) attachCoverageForSources();
        return true;
    }

    // A merged run is spread over files this server does not own, so a report or
    // clear action would be thrown away by the next refresh. Refuse, with
    // something the agent can act on.
    function denyWrite(): WriteResult | null {
        if (!groupName) return null;
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
    function seedCoverage(input: SeedInput, resultsAbs: string | null): boolean {
        if (!coverageEnabled) return false;
        resultsAbsPath = resultsAbs ?? resultsAbsPath;
        if (input.resultsDir) resultsTarget = { kind: "dir", dir: resolvePath(String(input.resultsDir)) };
        else if (resultsAbs) resultsTarget = { kind: "file", path: resultsAbs };
        if (input.projectRoot) {
            const next = resolvePath(String(input.projectRoot));
            const moved = next !== projectRoot;
            explicitProjectRoot = next;
            projectRoot = next;
            // Sources and the diff are resolved against the root, so a report
            // already on screen was read against the old one. Skipped when this
            // call also names a report, read against the new root below anyway.
            if (moved && coverageTarget && !input.coverageFile && !input.coverageDir) settleCoverage();
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
        if (!explicitProjectRoot && resultsAbsPath) projectRoot = findProjectRoot(dirname(resultsAbsPath));
        if (input.coverageFile) {
            const p = resolvePath(String(input.coverageFile));
            if (!projectRoot) projectRoot = findProjectRoot(dirname(p));
            if (requestCoverage({ kind: "file", path: p })) return true;
        }
        if (input.coverageDir) {
            const d = resolvePath(String(input.coverageDir));
            const found = existsSync(d) ? newestCoverageFileIn(d) : null;
            if (found && !projectRoot) projectRoot = findProjectRoot(dirname(found));
            // A named folder holding nothing is still the request: the run that
            // fills it may not have finished. Skipped only when a named file
            // already failed, since that reason is the more specific one.
            if (found || !input.coverageFile) {
                if (requestCoverage({ kind: "dir", dir: d })) return true;
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
        if (coverageEnabled && !coverage) refreshCoverageHint();
    }

    // Read a small JSON body. Still capped even though callers are authenticated
    // by this point, so a wedged page cannot grow the buffer without limit.
    async function readJsonBody(req: IncomingMessage): Promise<unknown> {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            const buf = chunk as Buffer;
            size += buf.length;
            if (size > 8192) throw new Error("body too large");
            chunks.push(buf);
        }
        // Decoded once at the end: a chunk boundary can fall inside a multi-byte
        // character, and decoding each chunk alone would turn its halves into
        // replacement characters.
        const text = Buffer.concat(chunks).toString("utf8");
        try {
            return JSON.parse(text || "null");
        } catch {
            throw new Error("invalid JSON");
        }
    }

    // `Authorization: Bearer <token>` rather than a body field so the check below
    // can run before the body is read.
    function bearerToken(req: IncomingMessage): string {
        const header = req.headers.authorization ?? "";
        return header.startsWith("Bearer ") ? header.slice(7) : "";
    }

    function sendJson(res: ServerResponse, status: number, body: unknown) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
    }

    // The page posts a row reference, never prompt text: the message is composed
    // here from this server's own results, so nothing that reaches the agent is
    // caller-supplied. `name` is checked against the index to catch a click that
    // raced a refresh, which would otherwise ask about the wrong test.
    async function handleAsk(req: IncomingMessage, res: ServerResponse) {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST required" });
        if (!onAsk) return sendJson(res, 501, { ok: false, error: "asking the agent is not available" });
        // Before the body is touched, so an unauthenticated caller cannot make
        // this server buffer anything.
        if (bearerToken(req) !== askToken) return sendJson(res, 403, { ok: false, error: "bad token" });

        let body: unknown;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad request" });
        }
        const payload = (body ?? {}) as { index?: unknown; name?: unknown };
        if (typeof payload.index !== "number" || !Number.isInteger(payload.index)) {
            return sendJson(res, 400, { ok: false, error: "index must be an integer" });
        }
        const test = results[payload.index];
        if (!test) return sendJson(res, 404, { ok: false, error: "no such row" });
        if (typeof payload.name === "string" && payload.name !== test.name) {
            return sendJson(res, 409, { ok: false, error: "results changed, reopen the row" });
        }

        try {
            await onAsk({ prompt: composeAskPrompt(test), test });
        } catch (err) {
            console.error("[server] onAsk failed:", err instanceof Error ? err.message : err);
            return sendJson(res, 502, { ok: false, error: "could not reach the session" });
        }
        return sendJson(res, 200, { ok: true });
    }

    // Same rule as /ask: the page names a scope and the prompt is composed here
    // from server-held data. Nothing the caller sends reaches the agent.
    async function handleAskCoverage(req: IncomingMessage, res: ServerResponse) {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST required" });
        if (!onAsk) return sendJson(res, 501, { ok: false, error: "asking the agent is not available" });
        if (bearerToken(req) !== askToken) return sendJson(res, 403, { ok: false, error: "bad token" });

        let body: unknown;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad request" });
        }
        const payload = (body ?? {}) as { scope?: unknown; path?: unknown };
        const scope = payload.scope;
        if (scope !== "file" && scope !== "patch" && scope !== "enable") {
            return sendJson(res, 400, { ok: false, error: "scope must be 'file', 'patch' or 'enable'" });
        }

        let prompt: string;
        if (scope === "enable") {
            const hint = coverageHint ?? suggestCoverageCommand(projectRoot, resultsAbsPath ?? undefined);
            prompt = composeEnableCoveragePrompt(hint.command, hint.ecosystem, hint.alternative);
        } else if (scope === "patch") {
            const patch = coverage?.payload.patch;
            if (!patch) return sendJson(res, 404, { ok: false, error: "no changed-code coverage to ask about" });
            prompt = composePatchCoveragePrompt(patch);
        } else {
            if (typeof payload.path !== "string") return sendJson(res, 400, { ok: false, error: "path must be a string" });
            // Looked up in the report rather than trusted: an unknown path is
            // rejected, so the prompt can only ever describe measured code.
            const entry = coverage?.report.files.find((f) => f.path === payload.path);
            if (!entry) return sendJson(res, 404, { ok: false, error: "no such file in the coverage report" });
            const uncoveredLines = Object.entries(entry.lines).filter(([, hits]) => hits === 0).map(([line]) => Number(line));
            prompt = composeCoveragePrompt({
                path: entry.path,
                uncoveredLines,
                percent: entry.totalLines ? Math.round((entry.coveredLines / entry.totalLines) * 100) : null,
            });
        }

        try {
            await onAsk({ prompt, coverage: { scope, path: scope === "file" ? String(payload.path) : undefined } });
        } catch (err) {
            console.error("[server] onAsk (coverage) failed:", err instanceof Error ? err.message : err);
            return sendJson(res, 502, { ok: false, error: "could not reach the session" });
        }
        return sendJson(res, 200, { ok: true });
    }

    // "Which tests does this change affect?" Same rule as /ask: the page names
    // the scope, the prompt is composed here, and the answer comes back as
    // canvas tags through set_impacted_tests rather than as text.
    async function handleAskImpact(req: IncomingMessage, res: ServerResponse) {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST required" });
        if (!onAsk) return sendJson(res, 501, { ok: false, error: "asking the agent is not available" });
        if (bearerToken(req) !== askToken) return sendJson(res, 403, { ok: false, error: "bad token" });
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
        } catch (err) {
            console.error("[server] onAsk (impact) failed:", err instanceof Error ? err.message : err);
            return sendJson(res, 502, { ok: false, error: "could not reach the session" });
        }
        return sendJson(res, 200, { ok: true });
    }

    // Reveal or open the run through the desktop shell. The page chooses the
    // action, never the path: that comes from this server's own source set, so a
    // page cannot name an unrelated file. Token-gated exactly like /ask.
    async function handleReveal(req: IncomingMessage, res: ServerResponse) {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST required" });
        if (bearerToken(req) !== askToken) return sendJson(res, 403, { ok: false, error: "bad token" });

        let body: unknown;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad request" });
        }
        const mode = (body as { mode?: unknown })?.mode;
        if (mode !== "reveal" && mode !== "open") {
            return sendJson(res, 400, { ok: false, error: "mode must be 'reveal' or 'open'" });
        }

        const target = revealTarget();
        if (!target) return sendJson(res, 404, { ok: false, error: "this run has no report file on disk" });
        const command = launchFor(mode, target, process.platform);
        if (!command) return sendJson(res, 501, { ok: false, error: `${process.platform} has no known file manager` });

        try {
            await launch(command);
        } catch (err) {
            console.error("[server] launch failed:", err instanceof Error ? err.message : err);
            return sendJson(res, 502, { ok: false, error: mode === "reveal" ? "could not open the file manager" : "could not open the report" });
        }
        return sendJson(res, 200, { ok: true });
    }

    // Source text plus per-line hits for one file in the loaded report.
    function handleSource(url: string, res: ServerResponse) {
        const u = new URL(url, "http://localhost");
        const path = u.searchParams.get("file") || "";
        if (!coverage) return sendJson(res, 404, { ok: false, error: "no coverage loaded" });
        const view = readSourceView(coverage, path);
        if (view === "unknown-file") return sendJson(res, 404, { ok: false, error: "no such file in the coverage report" });
        if (view === "no-source") return sendJson(res, 404, { ok: false, error: "the file could not be found on this machine" });
        if (view === "unreadable") return sendJson(res, 404, { ok: false, error: "the file could not be read" });
        return sendJson(res, 200, { ok: true, ...view });
    }

    // A page cannot set `Host` from JavaScript, so requiring the loopback address
    // this server actually bound is what stops a DNS-rebinding page: it would
    // arrive under its own name, and the browser would then treat our replies --
    // including the token embedded in the page -- as same-origin and readable.
    function fromLoopback(req: IncomingMessage): boolean {
        const addr = server.address() as AddressInfo | null;
        if (!addr) return false;
        const allowed = [`127.0.0.1:${addr.port}`, `localhost:${addr.port}`, `[::1]:${addr.port}`];
        if (!allowed.includes(req.headers.host ?? "")) return false;
        // Absent on same-origin navigations and on non-browser callers, so it is
        // only meaningful when the caller actually sends one.
        const origin = req.headers.origin;
        return !origin || allowed.some((h) => origin === `http://${h}`);
    }

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
                if (ok && !active) broadcast();
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
            } catch {
                res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("client bundle not found — run `npm run build`");
            }
            return;
        }
        try {
            const html = await renderShell(title, askToken);
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(html);
        } catch (err) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(`View error:\n${err instanceof Error ? err.stack : String(err)}`);
        }
    });

    // Prefer the requested port for a stable URL; fall back to an ephemeral one.
    const boundPort = await new Promise<number>((resolve) => {
        const addr = () => (server.address() as AddressInfo).port;
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
        setResults(list: ResultInput[]): WriteResult {
            const denied = denyWrite();
            if (denied) return denied;
            applyResults((list || []).map((t) => ({ name: t.name, status: normalizeStatus(t.status), durationMs: t.durationMs, message: t.message })), null);
            persist(results, file, discovered);
            broadcast();
            return { ok: true, total: results.length };
        },
        addResult(t: ResultInput): WriteResult {
            const denied = denyWrite();
            if (denied) return denied;
            results.push({ name: t.name, status: normalizeStatus(t.status), durationMs: t.durationMs, message: t.message });
            // Extending the run, not replacing it: baseline and agent tags hold.
            retag();
            persist(results, file, discovered);
            broadcast();
            return { ok: true, total: results.length };
        },
        clearResults(): WriteResult {
            const denied = denyWrite();
            if (denied) return denied;
            applyResults([], null);
            persist(results, file, discovered);
            broadcast();
            return { ok: true, total: 0 };
        },
        loadNamed(name: string) {
            if (groupDef && name === groupDef.name) {
                if (groupName === name) return true;
                if (!restoreGroup(groupDef)) return false;
                broadcast();
                return true;
            }
            const abs = resolveResultPath(name, discovered);
            if (!abs) return false;
            loadSingle(abs, name);
            broadcast();
            return true;
        },
        // Merge a named set of results files into one run — the openFiles(name,
        // files) shape. Returns per-source counts so the caller can verify the
        // merge instead of trusting it.
        openFiles(input: { name?: string; files: readonly string[] }): OpenFilesResult {
            const built = collectSources(input.files ?? []);
            if (!built.entries.length) {
                return { ok: false, error: "none of those paths could be read as a test-results file", skipped: built.skipped };
            }
            const name = groupNameFor(input.name, built.entries.length);
            // Same as the picker: this replaces the panel deliberately, so a
            // seed still waiting must not arrive later and undo it.
            awaitedSeed = null;
            applySources(built.entries, name);
            // Resolved to a single file, so this is an ordinary run, not a merge:
            // any group left from an earlier open must not stay in the picker.
            if (!name) groupDef = null;
            if (!explicitCoverage) attachCoverageForSources();
            broadcast();
            return {
                ok: true,
                total: results.length,
                sources: entries.map((e) => ({ label: e.source.label, count: e.source.count })),
                skipped: built.skipped,
            };
        },
        // Re-seed from fresh open input (e.g. a re-open pointing at a new file).
        loadInput(input: SeedInput = {}) {
            const abs = seed(input);
            // An explicit coverage report can resolve even when no results file
            // does, and a new project root re-resolves the report on screen.
            if (abs || input.coverageFile || input.coverageDir || input.projectRoot) broadcast();
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
        markImpacted(refs: readonly AgentTestRef[]) {
            const { tags, unmatched } = matchAgentTests(results, refs);
            const next = agentImpact ?? new Map<string, string>();
            for (const [i, reason] of tags) next.set(rowIdentity(results[i]), reason);
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
        loadCoverage(path: string) {
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
                } catch { /* ignore */ }
            }
            clients.clear();
            const closed = new Promise<void>((r) => server.close(() => r()));
            // Force-close open SSE connections so the server can finish closing.
            server.closeAllConnections?.();
            await closed;
        },
    };
}
