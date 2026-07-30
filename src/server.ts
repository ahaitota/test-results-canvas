// SDK-free HTTP server for the Test Results canvas: serves the view, streams
// updates over SSE, loads TRX/JUnit files, and watches the results directory.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FSWatcher } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve as resolvePath } from "node:path";
import { watch, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { serializeTrx, parseTrx } from "./parsers/trx.js";
import { parseJUnit } from "./parsers/junit.js";
import { labelForPath } from "./labels.js";
import { renderShell } from "./view.js";
import type { TestResult, TestStatus } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return null; }
    for (const n of names) {
        if (!RESULT_EXTS.some((e) => n.toLowerCase().endsWith(e))) continue;
        const abs = resolvePath(dir, n);
        try {
            const st = statSync(abs);
            if (st.isFile() && st.mtimeMs > bestMtime && looksLikeResults(readFileSync(abs, "utf8"))) {
                best = abs; bestMtime = st.mtimeMs;
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
    try { return readdirSync(EXTENSION_ROOT).filter((f) => RESULT_EXTS.some((e) => f.toLowerCase().endsWith(e))); }
    catch { return []; }
}

// Selectable files = local extension-folder reports + discovered project files.
function listResultFiles(discovered: Map<string, string>): string[] {
    let local: string[] = [];
    try { local = readdirSync(EXTENSION_ROOT).filter((f) => RESULT_EXTS.some((e) => f.toLowerCase().endsWith(e))).sort(); }
    catch { local = []; }
    const extras = [...discovered.keys()].filter((l) => !local.includes(l)).sort();
    return [...local, ...extras];
}

// Resolve a picker name to a safe absolute path (discovered label or a basename
// inside the extension folder — no path traversal). null if missing/unsupported.
function resolveResultPath(name: unknown, discovered: Map<string, string>): string | null {
    const raw = String(name || "");
    if (discovered.has(raw)) { const abs = discovered.get(raw)!; return existsSync(abs) ? abs : null; }
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

// Persist results as TRX, but only for writable local .trx files (never a
// discovered project file — that's the agent's own output).
function persist(results: TestResult[], name: string, discovered: Map<string, string>): void {
    if (discovered.has(String(name || ""))) return;
    const base = basename(String(name || DEFAULT_FILE)) || DEFAULT_FILE;
    if (!base.toLowerCase().endsWith(".trx")) return;
    try { writeFileSync(join(EXTENSION_ROOT, base), serializeTrx(results, { runName: "Test Results" }), "utf8"); }
    catch (err) { console.error("[server] failed to write TRX:", err instanceof Error ? err.message : err); }
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
    title?: string;
    port?: number;
    watch?: boolean;
    alsoRegister?: string[];
}

// A single result as accepted from SDK actions before its status is normalized.
interface ResultInput {
    name: string;
    status: unknown;
    durationMs?: number;
    message?: string;
}

// The handle returned by createResultsServer; the type the SDK glue stores per canvas.
export type ResultsServerHandle = Awaited<ReturnType<typeof createResultsServer>>;

// Start one Test Results server. Returns a handle with the URL plus methods the
// SDK actions (and tests) use to mutate state and tear down.
export async function createResultsServer(options: ResultsServerOptions = {}) {
    // watch=false disables the results-dir watcher.
    const { resultsFile, resultsDir, title = "Test Results", port = 0, watch: watchEnabled = true } = options;

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
    let watcher: FSWatcher | null = null;

    function statePayload() {
        return JSON.stringify({ title, results, file, files: listResultFiles(discovered) });
    }
    function broadcast() {
        for (const res of clients) res.write(`data: ${statePayload()}\n\n`);
    }
    function reload() {
        for (const res of clients) res.write(`event: reload\ndata: 1\n\n`);
    }

    function stopWatcher() {
        if (!watcher) return;
        try { watcher.close(); } catch { /* already closed */ }
        watcher = null;
    }
    function refreshFromDir(dir: string): void {
        const abs = newestResultsFileIn(dir);
        if (!abs) return;
        const label = labelForPath(abs, discovered, listLocalNames());
        discovered.set(label, abs);
        file = label;
        results = loadFile(label, discovered);
        broadcast();
    }
    function watchDir(dir: string): void {
        stopWatcher();
        const debounce = new Map<string, ReturnType<typeof setTimeout>>();
        try {
            watcher = watch(dir, { persistent: false }, (_event, filename) => {
                if (!filename) return;
                const name = String(filename);
                if (!RESULT_EXTS.some((e) => name.toLowerCase().endsWith(e))) return;
                const abs = resolvePath(dir, name);
                clearTimeout(debounce.get(abs));
                debounce.set(abs, setTimeout(() => { debounce.delete(abs); refreshFromDir(dir); }, 400));
            });
            watcher.on("error", (err) => console.error("[server] watcher error:", err?.message || err));
        } catch (err) {
            console.error(`[server] watch failed for ${dir}:`, err instanceof Error ? err.message : err);
        }
    }

    // Seed from an explicit file or the newest file in a directory.
    function seed(input: { resultsFile?: string; resultsDir?: string }): string | null {
        let abs: string | null = null;
        if (input.resultsFile) {
            const p = resolvePath(String(input.resultsFile));
            try { if (existsSync(p) && statSync(p).isFile() && looksLikeResults(readFileSync(p, "utf8"))) abs = p; }
            catch { /* unreadable */ }
        }
        if (!abs && input.resultsDir) {
            const d = resolvePath(String(input.resultsDir));
            if (existsSync(d)) abs = newestResultsFileIn(d);
        }
        if (!abs) return null;
        const label = labelForPath(abs, discovered, listLocalNames());
        discovered.set(label, abs);
        file = label;
        results = loadFile(label, discovered);
        if (watchEnabled) watchDir(dirname(abs));
        return abs;
    }

    if (!seed({ resultsFile, resultsDir })) results = loadFile(file, discovered);

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = req.url ?? "";
        if (url === "/events") {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            clients.add(res);
            res.write(`data: ${statePayload()}\n\n`);
            const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
            req.on("close", () => { clearInterval(keepAlive); clients.delete(res); });
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
            if (!resolveResultPath(name, discovered)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "unknown file" }));
                return;
            }
            file = name;
            results = loadFile(name, discovered);
            broadcast();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, file: name }));
            return;
        }
        try {
            const html = renderShell(title);
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
        const onError = () => { server.removeListener("error", onError); server.listen(0, "127.0.0.1", () => resolve(addr())); };
        server.once("error", onError);
        server.listen(port || 0, "127.0.0.1", () => { server.removeListener("error", onError); resolve(addr()); });
    });

    return {
        server,
        url: `http://127.0.0.1:${boundPort}/`,
        port: boundPort,
        currentFile: () => file,
        getResults: () => results,
        setResults(list: ResultInput[]) {
            results = (list || []).map((t) => ({ name: t.name, status: normalizeStatus(t.status), durationMs: t.durationMs, message: t.message }));
            persist(results, file, discovered);
            broadcast();
            return results.length;
        },
        addResult(t: ResultInput) {
            results.push({ name: t.name, status: normalizeStatus(t.status), durationMs: t.durationMs, message: t.message });
            persist(results, file, discovered);
            broadcast();
            return results.length;
        },
        clearResults() { results = []; persist(results, file, discovered); broadcast(); },
        loadNamed(name: string) {
            if (!resolveResultPath(name, discovered)) return false;
            file = name; results = loadFile(name, discovered); broadcast(); return true;
        },
        // Re-seed from fresh open input (e.g. a re-open pointing at a new file).
        loadInput(input: { resultsFile?: string; resultsDir?: string } = {}) {
            const abs = seed(input);
            if (abs) broadcast();
            return abs;
        },
        broadcast,
        reload,
        async close() {
            stopWatcher();
            for (const res of clients) { try { res.end(); } catch { /* ignore */ } }
            clients.clear();
            const closed = new Promise<void>((r) => server.close(() => r()));
            // Force-close open SSE connections so the server can finish closing.
            server.closeAllConnections?.();
            await closed;
        },
    };
}
