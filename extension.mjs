// Extension: example-canvas
// A test-results canvas that renders as a real UI panel in the Copilot app.
//
// Live updates use Server-Sent Events (SSE): the browser opens one persistent
// connection to /events, and the extension pushes new state over it whenever an
// action mutates the results. The page updates the DOM in place — no full-page
// reload, so no blink.

import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, basename, resolve as resolvePath } from "node:path";
import { watch, watchFile, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { serializeTrx, parseTrx } from "./src/parsers/trx.mjs";
import { parseJUnit } from "./src/parsers/junit.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEW_PATH = join(__dirname, "src", "view.mjs");
const DEFAULT_FILE = "results.trx";

// The canvas id declared below (used when programmatically opening the panel).
const CANVAS_ID = "example-canvas";

// Fixed port for a stable, bookmarkable browser URL (falls back to a random
// port if this one is already in use).
const FIXED_PORT = 4830;

// Supported result file formats: native TRX (.trx) and JUnit XML (.xml).
const RESULT_EXTS = [".trx", ".xml"];

// --- Agent-driven open + live refresh ---
//
// An extension cannot open its own canvas or discover the agent's working
// directory (all outbound session RPCs time out), so "auto-open when tests run"
// is delegated to the agent: after running tests, the agent opens THIS canvas
// and passes the results file (or directory) as input. From there the extension
// takes over: it loads the file and watches its directory, so every subsequent
// test re-run refreshes the already-open panel live over SSE — no reopen needed.

// Project results files opened by the agent: display label -> absolute path.
// These live outside the extension folder, so we keep an explicit registry
// rather than resolving by basename against __dirname.
const discovered = new Map();

// Bundled sample reports live in ./samples so they don't clutter the extension
// root. Register them up front so they still show in the panel's file picker as
// read-only "try it" data and resolve correctly when selected.
const SAMPLES_DIR = join(__dirname, "samples");
try {
    for (const f of readdirSync(SAMPLES_DIR)) {
        if (RESULT_EXTS.some((e) => f.toLowerCase().endsWith(e))) discovered.set(f, join(SAMPLES_DIR, f));
    }
} catch {
    /* no samples dir bundled */
}

// One directory watcher per open instance so re-running tests refreshes the
// panel live. instanceId -> { watcher, dir }.
const instanceWatchers = new Map();

// --- Automatic surfacing (the cross-project "no extra work" path) ---
//
// An extension can't open its own canvas, but a tool hook CAN see the agent's
// working directory and inject guidance the model reads. So after the agent runs
// tests, we detect the freshly written results file and tell the agent to open
// this canvas with that file. The agent opens it (which it's allowed to do) and
// the directory watcher above takes over for live refresh on re-runs.

// Tool-argument text that indicates a test run (covers common ecosystems).
const TEST_CMD_RE =
    /\b(dotnet\s+test|vstest|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|jest|vitest|mvn\s+(test|verify)|gradle\w*\s+test|pytest|py\.test|go\s+test|cargo\s+test|rspec|phpunit|ctest)\b|--junitxml|--?logger[= ]?["']?trx|surefire|failsafe|\.trx\b/i;

// Per-working-dir key of the last results file we surfaced, so we don't nag.
const lastSurfaced = new Map();

// Every result file that sits next to this extension is a selectable "results
// file". Users pick which one a panel shows; each panel remembers its choice.
// Files discovered in the agent's working directory are appended to the list.
function listResultFiles() {
    let local = [];
    try {
        local = readdirSync(__dirname)
            .filter((f) => RESULT_EXTS.some((e) => f.toLowerCase().endsWith(e)))
            .sort();
    } catch {
        local = [];
    }
    // Append discovered project files whose label doesn't collide with a local one.
    const extras = [...discovered.keys()].filter((label) => !local.includes(label)).sort();
    return [...local, ...extras];
}

// Resolve a user-supplied name to a safe path. Discovered project files are
// resolved via the registry (absolute path); everything else is resolved as a
// basename inside the extension folder (no path traversal). Returns null if the
// file is missing or an unsupported type.
function resolveResultPath(name) {
    const raw = String(name || "");
    // Discovered project file (its label maps to an absolute path).
    if (discovered.has(raw)) {
        const abs = discovered.get(raw);
        return existsSync(abs) ? abs : null;
    }
    const base = basename(raw);
    if (!RESULT_EXTS.some((e) => base.toLowerCase().endsWith(e))) return null;
    const full = join(__dirname, base);
    return existsSync(full) ? full : null;
}

// Parse the results from a named file, auto-detecting TRX vs JUnit by content
// (so a JUnit report saved as .trx, or vice versa, still parses correctly).
function loadFile(name) {
    const full = resolveResultPath(name);
    if (!full) return [];
    try {
        const xml = readFileSync(full, "utf8");
        return /<testsuites?[\s>]/i.test(xml) ? parseJUnit(xml) : parseTrx(xml);
    } catch (err) {
        console.error("[example-canvas] failed to read results file:", err);
        return [];
    }
}

// Write results back to a named file so they persist across reloads. Only
// native TRX files that live inside the extension folder are written; JUnit
// reports and project files discovered in the agent's working directory are
// treated as read-only sources and left untouched.
function persist(results, name) {
    // Never write to a discovered project file — those are the agent's own
    // test output and must not be clobbered by canvas edits.
    if (discovered.has(String(name || ""))) return;
    const base = basename(String(name || DEFAULT_FILE)) || DEFAULT_FILE;
    if (!base.toLowerCase().endsWith(".trx")) return;
    try {
        writeFileSync(join(__dirname, base), serializeTrx(results, { runName: "Test Results" }), "utf8");
    } catch (err) {
        console.error("[example-canvas] failed to write TRX:", err);
    }
}

// Load the view module fresh on every call so edits to view.mjs show up after a
// simple canvas refresh — no extension reload. The ?t=<timestamp> query string
// busts Node's ESM module cache so the file is re-read from disk each time.
async function renderShell(title) {
    const mod = await import(`${pathToFileURL(VIEW_PATH).href}?t=${Date.now()}`);
    return mod.renderShell(title);
}

// In-memory test result storage per canvas instance.
// Each test: { name, status: "pass"|"fail"|"skip", durationMs?, message? }
const instanceResults = new Map();

// Which TRX file each instance currently displays (instanceId -> filename).
const instanceFile = new Map();

// Open SSE connections per canvas instance: instanceId -> Set<ServerResponse>.
const instanceClients = new Map();

// One local HTTP server per canvas instance: instanceId -> { server, url, title }.
const servers = new Map();

function currentFile(instanceId) {
    return instanceFile.get(instanceId) || DEFAULT_FILE;
}

function getResults(instanceId) {
    if (!instanceResults.has(instanceId)) {
        // Seed from the instance's selected TRX file (defaults to results.trx).
        instanceResults.set(instanceId, loadFile(currentFile(instanceId)));
    }
    return instanceResults.get(instanceId);
}

function normalizeStatus(raw) {
    const s = String(raw || "").toLowerCase();
    if (s === "pass" || s === "passed" || s === "ok" || s === "success") return "pass";
    if (s === "fail" || s === "failed" || s === "error") return "fail";
    return "skip";
}

// Push the current state to every open SSE connection for an instance.
function broadcast(instanceId) {
    const clients = instanceClients.get(instanceId);
    if (!clients || clients.size === 0) return;
    const entry = servers.get(instanceId);
    const payload = JSON.stringify({
        title: entry?.title || "Test Results",
        results: getResults(instanceId),
        file: currentFile(instanceId),
        files: listResultFiles(),
    });
    for (const res of clients) {
        res.write(`data: ${payload}\n\n`);
    }
}

// Tell every open canvas (across all instances) to reload its page. Used when
// view.mjs changes on disk, so UI edits appear automatically with no button.
function broadcastReload() {
    for (const clients of instanceClients.values()) {
        for (const res of clients) {
            res.write(`event: reload\ndata: 1\n\n`);
        }
    }
}

// Watch the view file; when you save an edit, all open canvases reload.
watchFile(VIEW_PATH, { interval: 400 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) broadcastReload();
});

// --- Test-results file helpers (used when the agent opens the canvas pointed
// --- at a results file/dir, and for live-refreshing an open panel) ---

// Cheap content check so we only treat genuine test-results XML as results,
// not any stray .xml (configs, project files, etc.).
function looksLikeResults(xml) {
    const head = String(xml || "").slice(0, 8192);
    return /<testsuites?[\s>]/i.test(head) || /<TestRun[\s>]/i.test(head) || /<UnitTestResult[\s>]/i.test(head);
}

function listLocalNames() {
    try {
        return readdirSync(__dirname).filter((f) => RESULT_EXTS.some((e) => f.toLowerCase().endsWith(e)));
    } catch {
        return [];
    }
}

// Build a short, unique display label for a discovered file. Prefer the bare
// filename; if that collides with a different path, prefix the parent folder.
function labelForPath(abs) {
    for (const [label, p] of discovered) if (p === abs) return label;
    const name = basename(abs);
    const taken = (l) => discovered.has(l) || listLocalNames().includes(l);
    if (!taken(name)) return name;
    const withParent = `${basename(dirname(abs))}/${name}`;
    if (!taken(withParent)) return withParent;
    let i = 2;
    while (taken(`${withParent} (${i})`)) i++;
    return `${withParent} (${i})`;
}

// Find the most recently modified results file directly inside a directory.
function newestResultsFileIn(dir) {
    let best = null;
    let bestMtime = -1;
    let names = [];
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
            if (!st.isFile()) continue;
            if (st.mtimeMs > bestMtime && looksLikeResults(readFileSync(abs, "utf8"))) {
                best = abs;
                bestMtime = st.mtimeMs;
            }
        } catch {
            /* ignore unreadable entries */
        }
    }
    return best;
}

// Point an instance at a specific results file (or the newest results file in a
// directory), load it, and start watching that directory so later re-runs
// refresh the panel. Returns the resolved absolute path, or null if nothing
// usable was found.
function loadResultsForInstance(instanceId, input = {}) {
    let abs = null;
    if (input.resultsFile) {
        const p = resolvePath(String(input.resultsFile));
        try {
            if (existsSync(p) && statSync(p).isFile() && looksLikeResults(readFileSync(p, "utf8"))) abs = p;
        } catch {
            /* unreadable */
        }
    }
    if (!abs && input.resultsDir) {
        const d = resolvePath(String(input.resultsDir));
        if (existsSync(d)) abs = newestResultsFileIn(d);
    }
    if (!abs) return null;

    const label = labelForPath(abs);
    discovered.set(label, abs);
    instanceFile.set(instanceId, label);
    instanceResults.set(instanceId, loadFile(label));
    watchDirForInstance(instanceId, dirname(abs));
    return abs;
}

// Watch a directory (non-recursively) for results-file changes and live-refresh
// the given instance from the newest results file whenever one is written. This
// is how a re-run of the tests updates an already-open panel — it needs no app
// RPC, only the extension's own SSE broadcast.
function watchDirForInstance(instanceId, dir) {
    stopWatcher(instanceId);
    const debounce = new Map();
    let watcher;
    try {
        watcher = watch(dir, { persistent: false }, (_event, filename) => {
            if (!filename) return;
            const name = String(filename);
            if (!RESULT_EXTS.some((e) => name.toLowerCase().endsWith(e))) return;
            const abs = resolvePath(dir, name);
            clearTimeout(debounce.get(abs));
            debounce.set(abs, setTimeout(() => {
                debounce.delete(abs);
                refreshInstanceFromDir(instanceId, dir);
            }, 400));
        });
    } catch (err) {
        console.error(`[example-canvas] watch failed for ${dir}:`, err?.message || err);
        return;
    }
    watcher.on("error", (err) => console.error("[example-canvas] watcher error:", err?.message || err));
    instanceWatchers.set(instanceId, { watcher, dir });
}

// Load the newest valid results file in a watched directory into the instance
// and push it to the open panel over SSE.
function refreshInstanceFromDir(instanceId, dir) {
    const abs = newestResultsFileIn(dir);
    if (!abs) return;
    const label = labelForPath(abs);
    discovered.set(label, abs);
    instanceFile.set(instanceId, label);
    instanceResults.set(instanceId, loadFile(label));
    broadcast(instanceId);
    console.error(`[example-canvas] refreshed instance ${instanceId} from ${abs}`);
}

function stopWatcher(instanceId) {
    const w = instanceWatchers.get(instanceId);
    if (!w) return;
    try {
        w.watcher.close();
    } catch {
        /* already closed */
    }
    instanceWatchers.delete(instanceId);
}

// Bounded search for the newest valid results file under a directory (used by the
// tool hook after a test run). Depth- and budget-capped so it stays cheap even in
// large repos, and skips build/vcs/dependency noise.
function scanForRecentResults(rootDir, sinceMs) {
    const IGNORE = new Set(["node_modules", ".git", ".hg", ".svn", "bin", "obj", "dist", "out", ".vs", ".idea", ".venv"]);
    let best = null;
    let bestMtime = sinceMs;
    let budget = 4000; // max directory entries to visit
    const stack = [{ dir: rootDir, depth: 0 }];
    while (stack.length) {
        const { dir, depth } = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const ent of entries) {
            if (--budget < 0) return best;
            if (ent.isDirectory()) {
                if (depth >= 4 || IGNORE.has(ent.name)) continue;
                stack.push({ dir: resolvePath(dir, ent.name), depth: depth + 1 });
                continue;
            }
            if (!ent.isFile()) continue;
            if (!RESULT_EXTS.some((e) => ent.name.toLowerCase().endsWith(e))) continue;
            const abs = resolvePath(dir, ent.name);
            try {
                const st = statSync(abs);
                if (st.mtimeMs <= bestMtime) continue;
                if (!looksLikeResults(readFileSync(abs, "utf8"))) continue;
                best = abs;
                bestMtime = st.mtimeMs;
            } catch {
                /* ignore unreadable */
            }
        }
    }
    return best;
}

// Tool hook body (shared by success + failure): if the tool was a test run and a
// fresh results file exists in the working dir, return guidance telling the agent
// to open this canvas with that file. Returns undefined when there's nothing to do.
function surfaceIfResults(input) {
    try {
        const argText = JSON.stringify(input?.toolArgs ?? "");
        if (!TEST_CMD_RE.test(argText)) return undefined;
        const root = input?.workingDirectory;
        if (!root || !existsSync(root)) return undefined;
        const abs = scanForRecentResults(root, Date.now() - 120000);
        if (!abs) return undefined;
        const key = `${abs}:${statSync(abs).mtimeMs}`;
        if (lastSurfaced.get(root) === key) return undefined; // already told the agent
        lastSurfaced.set(root, key);
        console.error(`[example-canvas] hook surfacing results: ${abs}`);
        return {
            additionalContext:
                `The test run just produced a results file at "${abs}". ` +
                `Immediately open the "Test Results" canvas (canvasId "example-canvas") with ` +
                `input { "resultsFile": ${JSON.stringify(abs)} } so the user sees the results UI. ` +
                `Open it right away without asking, and don't print the results as text instead.`,
        };
    } catch (err) {
        console.error("[example-canvas] surfaceIfResults error:", err?.message || err);
        return undefined;
    }
}

// The HTML shell now lives in view.mjs and is loaded fresh on each request
// (see renderShell above), so UI edits only need a canvas refresh.

async function startServer(instanceId, title) {
    const server = createServer((req, res) => {
        if (req.url === "/events") {
            // Open a persistent SSE stream.
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            let clients = instanceClients.get(instanceId);
            if (!clients) {
                clients = new Set();
                instanceClients.set(instanceId, clients);
            }
            clients.add(res);

            // Send the current state immediately on connect.
            const entry = servers.get(instanceId);
            res.write(`data: ${JSON.stringify({
                title: entry?.title || title,
                results: getResults(instanceId),
                file: currentFile(instanceId),
                files: listResultFiles(),
            })}\n\n`);

            // Keep-alive comment every 15s so proxies don't drop the connection.
            const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
            req.on("close", () => {
                clearInterval(keepAlive);
                clients.delete(res);
            });
            return;
        }

        // List the selectable result files in the extension folder.
        if (req.url.startsWith("/files")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ files: listResultFiles(), current: currentFile(instanceId) }));
            return;
        }

        // Switch this instance to a different result file and push it live.
        if (req.url.startsWith("/load")) {
            const u = new URL(req.url, "http://localhost");
            const name = u.searchParams.get("file") || "";
            if (!resolveResultPath(name)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "unknown file" }));
                return;
            }
            instanceFile.set(instanceId, basename(name));
            instanceResults.set(instanceId, loadFile(name));
            broadcast(instanceId);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, file: basename(name) }));
            return;
        }

        // Any other path serves the HTML shell, loaded fresh from view.mjs.
        renderShell(title)
            .then((html) => {
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(html);
            })
            .catch((err) => {
                res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
                res.end(`View error:\n${err?.stack || err}`);
            });
    });

    // Prefer a fixed port so the browser URL is stable and bookmarkable. If it's
    // already in use, fall back to an OS-assigned ephemeral port.
    const port = await new Promise((resolve) => {
        const onError = () => {
            server.removeListener("error", onError);
            server.listen(0, "127.0.0.1", () => resolve(server.address().port));
        };
        server.once("error", onError);
        server.listen(FIXED_PORT, "127.0.0.1", () => {
            server.removeListener("error", onError);
            resolve(server.address().port);
        });
    });
    return { server, url: `http://127.0.0.1:${port}/`, title };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "example-canvas",
            displayName: "Test Results",
            description:
                "A visual test-results canvas that renders .NET TRX and JUnit XML runs. " +
                "IMPORTANT: after running a project's tests, open this canvas and pass the " +
                "results file as input so it appears automatically — set `resultsFile` to the " +
                "absolute path of the generated .trx/.xml, or `resultsDir` to the folder that " +
                "contains it (the newest results file is picked). The canvas then watches that " +
                "folder and refreshes live over SSE on every re-run — no need to reopen it. " +
                "Shows pass/fail/skip status, per-test duration, failure messages, and a summary. " +
                "Actions can also report individual results, load a full batch, or clear them.",
            inputSchema: {
                type: "object",
                properties: {
                    title: { type: "string", description: "Title for the test run (e.g. the suite or command)" },
                    resultsFile: {
                        type: "string",
                        description:
                            "Absolute path to a test-results file (.trx or JUnit .xml) generated by the " +
                            "test run. The canvas loads it and watches its folder for re-runs.",
                    },
                    resultsDir: {
                        type: "string",
                        description:
                            "Absolute path to a folder containing test-results files. The newest valid " +
                            ".trx/.xml is loaded and the folder is watched for re-runs. Ignored if " +
                            "resultsFile is given and valid.",
                    },
                },
            },
            actions: [
                {
                    name: "add_result",
                    description: "Report a single test result",
                    inputSchema: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "The test name" },
                            status: {
                                type: "string",
                                enum: ["pass", "fail", "skip"],
                                description: "The test outcome",
                            },
                            durationMs: { type: "number", description: "How long the test took, in milliseconds" },
                            message: { type: "string", description: "Failure message or output (shown for failing tests)" },
                        },
                        required: ["name", "status"],
                    },
                    handler: async (ctx) => {
                        const results = getResults(ctx.instanceId);
                        results.push({
                            name: ctx.input.name,
                            status: normalizeStatus(ctx.input.status),
                            durationMs: ctx.input.durationMs,
                            message: ctx.input.message,
                        });
                        persist(results, currentFile(ctx.instanceId));
                        broadcast(ctx.instanceId);
                        return { success: true, totalResults: results.length };
                    },
                },
                {
                    name: "set_results",
                    description: "Replace all results with a full batch of test results at once",
                    inputSchema: {
                        type: "object",
                        properties: {
                            results: {
                                type: "array",
                                description: "The full list of test results",
                                items: {
                                    type: "object",
                                    properties: {
                                        name: { type: "string" },
                                        status: { type: "string", enum: ["pass", "fail", "skip"] },
                                        durationMs: { type: "number" },
                                        message: { type: "string" },
                                    },
                                    required: ["name", "status"],
                                },
                            },
                        },
                        required: ["results"],
                    },
                    handler: async (ctx) => {
                        const normalized = (ctx.input.results || []).map((t) => ({
                            name: t.name,
                            status: normalizeStatus(t.status),
                            durationMs: t.durationMs,
                            message: t.message,
                        }));
                        instanceResults.set(ctx.instanceId, normalized);
                        persist(normalized, currentFile(ctx.instanceId));
                        broadcast(ctx.instanceId);
                        return { success: true, totalResults: normalized.length };
                    },
                },
                {
                    name: "clear_all",
                    description: "Remove all test results",
                    inputSchema: { type: "object", properties: {} },
                    handler: async (ctx) => {
                        instanceResults.set(ctx.instanceId, []);
                        persist([], currentFile(ctx.instanceId));
                        broadcast(ctx.instanceId);
                        return { success: true, message: "All results cleared" };
                    },
                },
                {
                    name: "get_results",
                    description: "Get the current list of all test results with a summary",
                    inputSchema: { type: "object", properties: {} },
                    handler: async (ctx) => {
                        const results = getResults(ctx.instanceId);
                        return {
                            results,
                            summary: {
                                total: results.length,
                                passed: results.filter((t) => t.status === "pass").length,
                                failed: results.filter((t) => t.status === "fail").length,
                                skipped: results.filter((t) => t.status === "skip").length,
                            },
                        };
                    },
                },
            ],
            open: async (ctx) => {
                // Panel header is always a fixed label, regardless of input.
                const title = "Test Results";
                // If the agent passed a results file/dir, load it and start
                // watching for re-runs before the page connects, so the first
                // SSE payload already shows the right data.
                try {
                    const loaded = loadResultsForInstance(ctx.instanceId, ctx.input || {});
                    if (loaded) console.error(`[example-canvas] instance ${ctx.instanceId} loaded ${loaded}`);
                } catch (err) {
                    console.error("[example-canvas] loadResultsForInstance failed:", err?.message || err);
                }
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId, title);
                    servers.set(ctx.instanceId, entry);
                } else {
                    entry.title = title;
                    broadcast(ctx.instanceId);
                }
                return { title, url: entry.url };
            },
            onClose: async (ctx) => {
                stopWatcher(ctx.instanceId);
                const clients = instanceClients.get(ctx.instanceId);
                if (clients) {
                    for (const res of clients) res.end();
                    instanceClients.delete(ctx.instanceId);
                }
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    instanceResults.delete(ctx.instanceId);
                    instanceFile.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
    hooks: {
        // After the agent runs tests, detect the fresh results file and tell it
        // to open this canvas — the automatic, cross-project surfacing path.
        onPostToolUse: async (input) => surfaceIfResults(input),
        // Failing tests return a non-success result, so onPostToolUse doesn't
        // fire for them; surface on failure too (that's when results matter most).
        onPostToolUseFailure: async (input) => surfaceIfResults(input),
    },
});
