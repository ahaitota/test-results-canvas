// Host-free state for the Test Results UI: file discovery, parsing, watching and
// mutation. Both hosts wrap this and differ only in how they deliver it —
// src/server.ts serves it over HTTP + SSE for the Copilot canvas, and
// vscode/src/extension.ts pushes it over the webview postMessage channel.
//
// Nothing here imports an SDK or the vscode module, so it is unit-testable and
// reusable as-is. The extension folder is injected (rootDir) rather than derived
// from import.meta.url, because the VS Code host is bundled to CommonJS where
// import.meta does not exist.

import { watch, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { dirname, join, basename, resolve as resolvePath } from "node:path";
import { serializeTrx, parseTrx } from "../parsers/trx.js";
import { parseJUnit } from "../parsers/junit.js";
import { labelForPath } from "../labels.js";
import type { CanvasState, TestResult, TestStatus } from "../types.js";

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

// A single result as accepted from host actions, before its status is normalized.
export interface ResultInput {
    name: string;
    status: unknown;
    durationMs?: number;
    message?: string;
}

export interface ResultsStoreOptions {
    // Folder holding the extension's own report files and bundled samples.
    rootDir: string;
    resultsFile?: string;
    resultsDir?: string;
    title?: string;
    watch?: boolean;
    alsoRegister?: string[];
}

export class ResultsStore {
    readonly title: string;

    private readonly root: string;
    private readonly samplesDir: string;
    private readonly watchEnabled: boolean;
    // label -> absolute path, for files outside the extension folder.
    private readonly discovered = new Map<string, string>();
    private readonly listeners = new Set<(state: CanvasState) => void>();
    private watcher: FSWatcher | null = null;
    private results: TestResult[] = [];
    private file = DEFAULT_FILE;

    constructor(options: ResultsStoreOptions) {
        this.root = options.rootDir;
        this.samplesDir = join(this.root, "samples");
        this.title = options.title ?? "Test Results";
        this.watchEnabled = options.watch !== false;

        this.registerSamples();
        for (const p of options.alsoRegister || []) {
            try {
                const abs = resolvePath(String(p));
                if (existsSync(abs)) this.discovered.set(this.labelFor(abs), abs);
            } catch { /* ignore */ }
        }
        if (!this.seed({ resultsFile: options.resultsFile, resultsDir: options.resultsDir })) {
            this.results = this.loadFile(this.file);
        }
    }

    // --- reading ---

    state(): CanvasState {
        return { title: this.title, results: this.results, file: this.file, files: this.listResultFiles() };
    }

    getResults(): TestResult[] {
        return this.results;
    }

    currentFile(): string {
        return this.file;
    }

    // Absolute path behind a picker label, or null when it is not selectable.
    resolveResultPath(name: unknown): string | null {
        const raw = String(name || "");
        if (this.discovered.has(raw)) {
            const abs = this.discovered.get(raw)!;
            return existsSync(abs) ? abs : null;
        }
        const base = basename(raw);
        if (!RESULT_EXTS.some((e) => base.toLowerCase().endsWith(e))) return null;
        const full = join(this.root, base);
        return existsSync(full) ? full : null;
    }

    // --- subscribing ---
    onChange(listener: (state: CanvasState) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    emit(): void {
        const snapshot = this.state();
        for (const listener of this.listeners) listener(snapshot);
    }

    // --- mutating ---

    // Add files to the picker without selecting any of them. Used by the VS Code
    // host to offer every results file it can find in the workspace.
    register(paths: string[]): void {
        const known = new Set(this.discovered.values());
        let added = false;
        for (const p of paths) {
            const abs = resolvePath(String(p));
            if (known.has(abs) || !existsSync(abs)) continue;
            this.discovered.set(this.labelFor(abs), abs);
            known.add(abs);
            added = true;
        }
        if (added) this.emit();
    }

    setResults(list: ResultInput[]): number {
        this.results = (list || []).map((t) => this.toResult(t));
        this.persist();
        this.emit();
        return this.results.length;
    }

    addResult(t: ResultInput): number {
        this.results.push(this.toResult(t));
        this.persist();
        this.emit();
        return this.results.length;
    }

    clearResults(): void {
        this.results = [];
        this.persist();
        this.emit();
    }

    // Select an already-known file by its picker label.
    loadNamed(name: string): boolean {
        if (!this.resolveResultPath(name)) return false;
        this.file = name;
        this.results = this.loadFile(name);
        this.emit();
        return true;
    }

    // Re-seed from fresh host input (e.g. a re-open pointing at a new file).
    loadInput(input: { resultsFile?: string; resultsDir?: string } = {}): string | null {
        const abs = this.seed(input);
        if (abs) this.emit();
        return abs;
    }

    dispose(): void {
        this.stopWatcher();
        this.listeners.clear();
    }

    // --- internals ---

    private toResult(t: ResultInput): TestResult {
        return { name: t.name, status: normalizeStatus(t.status), durationMs: t.durationMs, message: t.message };
    }

    private labelFor(abs: string): string {
        return labelForPath(abs, this.discovered, this.listLocalNames());
    }

    // Result files sitting in the extension folder itself.
    private listLocalNames(): string[] {
        try {
            return readdirSync(this.root).filter((f) => RESULT_EXTS.some((e) => f.toLowerCase().endsWith(e)));
        } catch {
            return [];
        }
    }

    // Selectable files = local extension-folder reports + discovered project files.
    private listResultFiles(): string[] {
        const local = this.listLocalNames().sort();
        const extras = [...this.discovered.keys()].filter((l) => !local.includes(l)).sort();
        return [...local, ...extras];
    }

    // Parse a named file, auto-detecting TRX vs JUnit by content.
    private loadFile(name: string): TestResult[] {
        const full = this.resolveResultPath(name);
        if (!full) return [];
        try {
            const xml = readFileSync(full, "utf8");
            return /<testsuites?[\s>]/i.test(xml) ? parseJUnit(xml) : parseTrx(xml);
        } catch {
            return [];
        }
    }

    // Persist results as TRX, but only for writable local .trx files (never a
    // discovered project file — that one belongs to the test run, not to us).
    private persist(): void {
        if (this.discovered.has(this.file)) return;
        const base = basename(this.file || DEFAULT_FILE) || DEFAULT_FILE;
        if (!base.toLowerCase().endsWith(".trx")) return;
        try {
            writeFileSync(join(this.root, base), serializeTrx(this.results, { runName: "Test Results" }), "utf8");
        } catch (err) {
            console.error("[store] failed to write TRX:", err instanceof Error ? err.message : err);
        }
    }

    private registerSamples(): void {
        try {
            for (const f of readdirSync(this.samplesDir)) {
                if (RESULT_EXTS.some((e) => f.toLowerCase().endsWith(e))) this.discovered.set(f, join(this.samplesDir, f));
            }
        } catch { /* no samples bundled */ }
    }

    // Seed from an explicit file or the newest file in a directory.
    private seed(input: { resultsFile?: string; resultsDir?: string }): string | null {
        let abs: string | null = null;
        if (input.resultsFile) {
            const p = resolvePath(String(input.resultsFile));
            try {
                if (existsSync(p) && statSync(p).isFile() && looksLikeResults(readFileSync(p, "utf8"))) abs = p;
            } catch { /* unreadable */ }
        }
        if (!abs && input.resultsDir) {
            const d = resolvePath(String(input.resultsDir));
            if (existsSync(d)) abs = newestResultsFileIn(d);
        }
        if (!abs) return null;
        this.adopt(abs);
        if (this.watchEnabled) this.watchDir(dirname(abs));
        return abs;
    }

    private adopt(abs: string): void {
        const label = this.labelFor(abs);
        this.discovered.set(label, abs);
        this.file = label;
        this.results = this.loadFile(label);
    }

    private refreshFromDir(dir: string): void {
        const abs = newestResultsFileIn(dir);
        if (!abs) return;
        this.adopt(abs);
        this.emit();
    }

    private watchDir(dir: string): void {
        this.stopWatcher();
        const debounce = new Map<string, ReturnType<typeof setTimeout>>();
        try {
            this.watcher = watch(dir, { persistent: false }, (_event, filename) => {
                if (!filename) return;
                const name = String(filename);
                if (!RESULT_EXTS.some((e) => name.toLowerCase().endsWith(e))) return;
                const abs = resolvePath(dir, name);
                clearTimeout(debounce.get(abs));
                debounce.set(abs, setTimeout(() => {
                    debounce.delete(abs);
                    this.refreshFromDir(dir);
                }, 400));
            });
            this.watcher.on("error", (err) => console.error("[store] watcher error:", err?.message || err));
        } catch (err) {
            console.error(`[store] watch failed for ${dir}:`, err instanceof Error ? err.message : err);
        }
    }

    private stopWatcher(): void {
        if (!this.watcher) return;
        try {
            this.watcher.close();
        } catch { /* already closed */ }
        this.watcher = null;
    }
}
