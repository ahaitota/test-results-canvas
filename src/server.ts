// SDK-free HTTP server for the Test Results canvas: serves the view, streams
// updates over SSE, loads TRX/JUnit files, and watches the results directory.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FSWatcher } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, basename, resolve as resolvePath } from "node:path";
import { watch, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { serializeTrx, parseTrx } from "./parsers/trx.js";
import { parseJUnit } from "./parsers/junit.js";
import { labelForPath } from "./labels.js";
import { mergeSources } from "./sources.js";
import type { Source } from "./sources.js";
import { composeAskPrompt, composeCoveragePrompt, composePatchCoveragePrompt, composeEnableCoveragePrompt } from "./ask.js";
import { loadCoverageFile } from "./coverage/load.js";
import type { LoadedCoverage } from "./coverage/load.js";
import { discoverCoverageFor, newestCoverageFileIn } from "./coverage/discover.js";
import { findProjectRoot } from "./coverage/sources.js";
import { suggestCoverageCommand } from "./coverage/suggest.js";
import type { CoverageSuggestion } from "./coverage/suggest.js";
import { readSourceView } from "./coverage/source.js";
import { hasCoverageExt } from "./coverage/detect.js";
import type { GitExec } from "./coverage/gitdiff.js";
import { randomBytes } from "node:crypto";
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

export const RESULT_EXTS = [".trx", ".xml"];

// Cheap content check so we only treat genuine test-results XML as results.
export function looksLikeResults(xml: unknown): boolean {
    const head = String(xml || "").slice(0, 8192);
    return /<testsuites?[\s>]/i.test(head) || /<TestRun[\s>]/i.test(head) || /<UnitTestResult[\s>]/i.test(head);
}

// Newest results file directly inside a directory (non-recursive).
export function newestResultsFileIn(dir: string): string | null {
    let best: string | null = null, bestMtime = -1;
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return null;
    }
    for (const n of names) {
        if (!RESULT_EXTS.some((e) => n.toLowerCase().endsWith(e))) continue;
        const abs = resolvePath(dir, n);
        try {
            const st = statSync(abs);
            if (st.isFile() && st.mtimeMs > bestMtime && looksLikeResults(readFileSync(abs, "utf8"))) {
                best = abs;
                bestMtime = st.mtimeMs;
            }
        } catch { /* ignore unreadable */ }
    }
    return best;
}

export function normalizeStatus(raw: unknown): TestStatus {
    const s = String(raw || "").toLowerCase();
    if (s === "pass" || s === "passed" || s === "ok" || s === "success") return "pass";
    if (s === "fail" || s === "failed" || s === "error") return "fail";
    return "skip";
}

function listLocalNames(): string[] {
    try {
        return readdirSync(EXTENSION_ROOT).filter((f) => RESULT_EXTS.some((e) => f.toLowerCase().endsWith(e)));
    } catch {
        return [];
    }
}

// Selectable files = local extension-folder reports + discovered project files.
function listResultFiles(discovered: Map<string, string>): string[] {
    let local: string[] = [];
    try {
        local = readdirSync(EXTENSION_ROOT).filter((f) => RESULT_EXTS.some((e) => f.toLowerCase().endsWith(e))).sort();
    } catch {
        local = [];
    }
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

// Parse a named file, auto-detecting TRX vs JUnit by content.
function loadFile(name: string, discovered: Map<string, string>): TestResult[] {
    const full = resolveResultPath(name, discovered);
    if (!full) return [];
    try {
        const xml = readFileSync(full, "utf8");
        return /<testsuites?[\s>]/i.test(xml) ? parseJUnit(xml) : parseTrx(xml);
    } catch { return []; }
}

// Parse an absolute path, or null when it is missing, unreadable, or not a
// results file at all. Distinct from loadFile()'s empty array: a source set has
// to tell "this file reported no tests" from "this path is not a report".
function parseResultsFile(abs: string): TestResult[] | null {
    try {
        const xml = readFileSync(abs, "utf8");
        if (!looksLikeResults(xml)) return null;
        return /<testsuites?[\s>]/i.test(xml) ? parseJUnit(xml) : parseTrx(xml);
    } catch { return null; }
}

// One file in the active set, with its parsed rows cached so a change re-parses
// only the file that changed and the merge is rebuilt from memory.
interface SourceEntry {
    source: Source;
    rows: TestResult[];
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
    title?: string;
    port?: number;
    watch?: boolean;
    alsoRegister?: string[];
    // Turn off coverage discovery entirely.
    coverage?: boolean;
    // Injected for tests; `null` disables the changed-lines section outright.
    gitExec?: GitExec | null;
    // Called when the user clicks "Ask agent" on a row. Injected rather than
    // imported so this module stays host-free: the extension passes a closure
    // over session.send, tests pass a spy.
    onAsk?: (req: AskRequest) => void | Promise<void>;
}

// What POST /ask hands to the host once the row has been resolved server-side.
// `test` is set for a test-row ask and `coverage` for one raised from the
// coverage view; exactly one of them is present.
export interface AskRequest {
    prompt: string;
    test?: TestResult;
    coverage?: { scope: "file" | "patch" | "enable"; path?: string };
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

// Start one Test Results server. Returns a handle with the URL plus methods the
// SDK actions (and tests) use to mutate state and tear down.
export async function createResultsServer(options: ResultsServerOptions = {}) {
    // watch=false disables the results-dir watcher.
    const { resultsFile, resultsDir, title = "Test Results", port = 0, watch: watchEnabled = true, onAsk } = options;
    const coverageEnabled = options.coverage !== false;

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
    // One watcher per directory the sources live in.
    const watchers = new Map<string, FSWatcher>();

    // `coverageWatcher` follows the report's folder so a re-run refreshes the
    // panel the same way results already do.
    let coverage: LoadedCoverage | null = null;
    let coverageWatcher: FSWatcher | null = null;
    let projectRoot: string | undefined;
    let coverageHint: CoverageSuggestion | null = null;
    // Used to find the coverage report that belongs with the loaded results.
    let resultsAbsPath: string | null = null;
    // Set when the caller named a coverage report outright, so a results refresh
    // never re-discovers over the top of an explicit choice.
    let explicitCoverage = false;

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
            files: selectableFiles(),
            // Null for the classic single-file case, so a one-file panel renders
            // exactly as it did. Only what the header shows: a path would be
            // payload the UI never reads.
            group: groupName
                ? { name: groupName, sources: entries.map((e) => ({ label: e.source.label, count: e.source.count })) }
                : null,
            coverage: coverage?.payload ?? null,
            coverageHint,
        });
    }
    function broadcast() {
        for (const res of clients) res.write(`data: ${statePayload()}\n\n`);
    }
    function reload() {
        for (const res of clients) res.write(`event: reload\ndata: 1\n\n`);
    }

    function stopWatchers(): void {
        for (const w of watchers.values()) {
            try {
                w.close();
            } catch { /* already closed */ }
        }
        watchers.clear();
    }
    function stopCoverageWatcher() {
        if (!coverageWatcher) return;
        try {
            coverageWatcher.close();
        } catch { /* already closed */ }
        coverageWatcher = null;
    }

    // --- Coverage loading ---

    // Re-read the report currently loaded (a re-run overwrites it in place).
    function reloadCoverage(): boolean {
        if (!coverage) return false;
        const next = loadCoverageFile(coverage.path, loadOptions());
        if (!next) return false;
        coverage = next;
        return true;
    }

    // Returns false when the path is not a readable coverage report, leaving
    // the previous state alone.
    function setCoverage(absPath: string): boolean {
        const loaded = loadCoverageFile(absPath, loadOptions());
        if (!loaded) return false;
        coverage = loaded;
        if (!projectRoot) projectRoot = loaded.projectRoot;
        refreshCoverageHint();
        if (watchEnabled) watchCoverageDir(dirname(absPath));
        return true;
    }

    // Separate from the results watcher because the two files usually live in
    // different folders (`coverage/lcov.info` vs `test-results/junit.xml`).
    function watchCoverageDir(dir: string): void {
        stopCoverageWatcher();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            coverageWatcher = watch(dir, { persistent: false }, (_event, filename) => {
                if (!filename || !hasCoverageExt(String(filename))) return;
                clearTimeout(timer);
                timer = setTimeout(() => {
                    // dotnet writes a fresh guid folder while c8 and jacoco
                    // overwrite, so re-discover rather than assume.
                    const next = newestCoverageFileIn(dir);
                    if (next && next !== coverage?.path) {
                        if (setCoverage(next)) broadcast();
                        return;
                    }
                    if (reloadCoverage()) broadcast();
                }, 400);
            });
            coverageWatcher.on("error", (err) => console.error("[server] coverage watcher error:", err?.message || err));
        } catch (err) {
            console.error(`[server] coverage watch failed for ${dir}:`, err instanceof Error ? err.message : err);
        }
    }

    // Find and load the report that belongs with the results file just loaded.
    function attachCoverage(resultsAbs: string | null): void {
        if (!coverageEnabled) return;
        resultsAbsPath = resultsAbs;
        if (resultsAbs) projectRoot = findProjectRoot(dirname(resultsAbs));
        refreshCoverageHint();
        if (!resultsAbs) return;
        const found = discoverCoverageFor(resultsAbs, projectRoot);
        if (found) setCoverage(found);
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
        // Called without a projectRoot on purpose: that arm walks the conventional
        // folders and then the whole repo, so in a solution every project would
        // "find" a report — usually another project's. Only a report living with
        // the source counts as that source's own.
        const owners = entries.map((e) => e.source.path).filter((p) => discoverCoverageFor(p));
        if (owners.length === 1) {
            attachCoverage(owners[0]);
            return;
        }
        // No single report speaks for the merged run: show none, and let the
        // existing hint say how to produce one.
        coverage = null;
        stopCoverageWatcher();
        resultsAbsPath = entries[0].source.path;
        projectRoot = findProjectRoot(dirname(resultsAbsPath));
        refreshCoverageHint();
    }

    // --- The source set ---

    // The merged run appears in the picker under its own name, alongside the
    // individual files.
    function selectableFiles(): string[] {
        const list = listResultFiles(discovered);
        return groupName && !list.includes(groupName) ? [groupName, ...list] : list;
    }

    function buildEntry(abs: string): SourceEntry | null {
        const rows = parseResultsFile(abs);
        if (rows === null) return null;
        const label = labelForPath(abs, discovered, listLocalNames());
        discovered.set(label, abs);
        return { source: { label, path: abs, count: rows.length }, rows };
    }

    // Resolve named files into sources, reporting what fell out so the caller
    // can hand back a receipt rather than a silent partial merge.
    function collectSources(files: readonly string[]): { entries: SourceEntry[]; skipped: SkippedPath[] } {
        const built: SourceEntry[] = [];
        const skipped: SkippedPath[] = [];
        const seen = new Set<string>();
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
    function applySources(list: SourceEntry[], name: string | null): void {
        entries = list;
        groupName = name;
        rebuild();
        if (watchEnabled) syncWatchers();
    }

    function rebuild(): void {
        // One file is not a merged run: tagging its rows would put a "File" the
        // picker already names into every row's detail. Sliced rather than used
        // directly, so add_result can't grow the source's cached parse.
        results = entries.length === 1
            ? entries[0].rows.slice()
            : mergeSources(entries.map((e) => ({ source: e.source, results: e.rows })));
        if (entries.length) file = groupName ?? entries[0].source.label;
    }

    // Re-read one source in place. False when nothing usable came back, so a
    // half-written file keeps showing the rows it already had.
    function reparse(entry: SourceEntry, abs: string): boolean {
        const rows = parseResultsFile(abs);
        if (rows === null) return false;
        const label = abs === entry.source.path ? entry.source.label : labelForPath(abs, discovered, listLocalNames());
        if (abs !== entry.source.path) discovered.set(label, abs);
        entry.rows = rows;
        entry.source = { label, path: abs, count: rows.length };
        return true;
    }

    // Only the sources living in `dir` are touched: a five-project group must
    // not re-read four untouched files because the fifth was rewritten.
    function refreshDir(dir: string, changedName: string): void {
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
        } else {
            for (const entry of here) {
                if (basename(entry.source.path) === changedName && reparse(entry, entry.source.path)) changed = true;
            }
        }
        if (!changed) return;
        rebuild();
        // A moved report means the coverage beside it moved too. An explicitly
        // named report is left alone — the caller chose it.
        if (moved && !explicitCoverage) attachCoverageForSources();
        broadcast();
    }

    function startWatch(dir: string): void {
        const debounce = new Map<string, ReturnType<typeof setTimeout>>();
        try {
            const w = watch(dir, { persistent: false }, (_event, filename) => {
                if (!filename) return;
                const name = String(filename);
                if (!RESULT_EXTS.some((e) => name.toLowerCase().endsWith(e))) return;
                clearTimeout(debounce.get(name));
                debounce.set(name, setTimeout(() => {
                    debounce.delete(name);
                    refreshDir(dir, name);
                }, 400));
            });
            w.on("error", (err) => console.error("[server] watcher error:", err?.message || err));
            watchers.set(dir, w);
        } catch (err) {
            console.error(`[server] watch failed for ${dir}:`, err instanceof Error ? err.message : err);
        }
    }

    // One watcher per directory the sources live in, recomputed from the active
    // set: several sources in one folder share a watcher, and a folder nothing
    // points at any more is dropped.
    function syncWatchers(): void {
        const wanted = new Set(entries.map((e) => dirname(e.source.path)));
        for (const [dir, w] of watchers) {
            if (wanted.has(dir)) continue;
            try {
                w.close();
            } catch { /* already closed */ }
            watchers.delete(dir);
        }
        for (const dir of wanted) if (!watchers.has(dir)) startWatch(dir);
    }

    // Seed from a set of files, or from the original single file/dir.
    function seed(input: SeedInput): string | null {
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
            let abs: string | null = null;
            if (input.resultsFile) {
                const p = resolvePath(String(input.resultsFile));
                // isFile, so a folder handed to resultsFile falls through to the
                // resultsDir branch rather than swallowing it.
                try {
                    if (existsSync(p) && statSync(p).isFile()) abs = p;
                } catch { /* unreadable */ }
            }
            if (!abs && input.resultsDir) {
                const d = resolvePath(String(input.resultsDir));
                if (existsSync(d)) abs = newestResultsFileIn(d);
            }
            const entry = abs ? buildEntry(abs) : null;
            if (entry) {
                applySources([entry], null);
                loaded = true;
            }
        }

        // Honoured even when no results file resolved: the agent may be pointing
        // the panel at coverage for a run whose report it could not find.
        explicitCoverage = seedCoverage(input, entries[0]?.source.path ?? null);
        if (!loaded) return null;
        if (!explicitCoverage) attachCoverageForSources();
        return entries[0].source.path;
    }

    // A named set keeps its name even at one file — the caller asked for one.
    function groupNameFor(name: string | undefined, count: number): string | null {
        return name || (count > 1 ? "Merged results" : null);
    }

    // Load one file on its own, leaving any merged run behind — picking a file
    // outside it is a deliberate departure. `label` is the picker name chosen,
    // which is what the <select> expects to see back.
    function loadSingle(abs: string, label: string): void {
        const entry = buildEntry(abs);
        // Registered but unparseable: keep the old behaviour of showing an empty
        // run rather than refusing the selection outright.
        applySources(entry ? [entry] : [], null);
        file = label;
        attachCoverage(abs);
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

    // True when an explicit coverageFile/coverageDir produced a report.
    function seedCoverage(input: SeedInput, resultsAbs: string | null): boolean {
        if (!coverageEnabled) return false;
        resultsAbsPath = resultsAbs ?? resultsAbsPath;
        if (input.coverageFile) {
            const p = resolvePath(String(input.coverageFile));
            if (!projectRoot) projectRoot = findProjectRoot(dirname(p));
            if (setCoverage(p)) return true;
        }
        if (input.coverageDir) {
            const d = resolvePath(String(input.coverageDir));
            const found = existsSync(d) ? newestCoverageFileIn(d) : null;
            if (found) {
                if (!projectRoot) projectRoot = findProjectRoot(dirname(found));
                if (setCoverage(found)) return true;
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
        results = loadFile(file, discovered);
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
            prompt = composeEnableCoveragePrompt(hint.command, hint.ecosystem);
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
            // The merged run is listed in the picker under its own name, so
            // re-selecting it must not 404 — it is already what is loaded.
            if (groupName && name === groupName) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, file: name }));
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
        if (url.startsWith("/source")) {
            handleSource(url, res);
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
        getResults: () => results,
        setResults(list: ResultInput[]): WriteResult {
            const denied = denyWrite();
            if (denied) return denied;
            results = (list || []).map((t) => ({ name: t.name, status: normalizeStatus(t.status), durationMs: t.durationMs, message: t.message }));
            persist(results, file, discovered);
            broadcast();
            return { ok: true, total: results.length };
        },
        addResult(t: ResultInput): WriteResult {
            const denied = denyWrite();
            if (denied) return denied;
            results.push({ name: t.name, status: normalizeStatus(t.status), durationMs: t.durationMs, message: t.message });
            persist(results, file, discovered);
            broadcast();
            return { ok: true, total: results.length };
        },
        clearResults(): WriteResult {
            const denied = denyWrite();
            if (denied) return denied;
            results = [];
            persist(results, file, discovered);
            broadcast();
            return { ok: true, total: 0 };
        },
        loadNamed(name: string) {
            if (groupName && name === groupName) return true;
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
            applySources(built.entries, input.name || "Merged results");
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
            // does, and that still changes what the panel shows.
            if (abs || input.coverageFile || input.coverageDir) broadcast();
            return abs;
        },
        // Coverage accessors, mirroring the results ones above.
        getCoverage: () => coverage?.payload ?? null,
        coveragePath: () => coverage?.path ?? null,
        projectRoot: () => projectRoot,
        loadCoverage(path: string) {
            if (!setCoverage(resolvePath(path))) return false;
            broadcast();
            return true;
        },
        broadcast,
        reload,
        async close() {
            stopWatchers();
            stopCoverageWatcher();
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
