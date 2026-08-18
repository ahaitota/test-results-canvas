// Extension: example-canvas
// A test-results canvas that renders as a real UI panel in the Copilot app.
//
// This file is the SDK glue only: it declares the canvas, its actions, and the
// tool hook that surfaces results after a test run. All host-free work (the HTTP
// server, SSE, file loading/watching, rendering) lives in ./src/server.ts so it
// can be unit- and Playwright-tested without the app host.
//
// Live updates use Server-Sent Events (SSE): the browser opens one persistent
// connection to /events, and the server pushes new state whenever results change.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { watchFile, existsSync, statSync } from "node:fs";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { createResultsServer, scanForResults } from "./src/server.js";
// Action/open input reaches handlers typed as `unknown`; narrow it here first.
import { asResultInput, asOpenInput } from "./src/validate.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEW_PATH = join(__dirname, "src", "view.js");
const STYLES_PATH = join(__dirname, "src", "styles.js");
const CLIENT_BUNDLE = join(__dirname, "client", "app.js");
// The canvas id declared below (used when programmatically opening the panel).
const CANVAS_ID = "example-canvas";
// Fixed port for a stable, bookmarkable browser URL (the server falls back to a
// random port if this one is already taken).
const FIXED_PORT = 4830;
// One server per open canvas instance: instanceId -> handle from createResultsServer.
const servers = new Map();
// The joined session, reachable from canvas handlers so a panel can post a
// message back into its own conversation. Held in an object rather than a plain
// binding because the host re-opens already-open panels as soon as the canvas is
// declared -- which can happen before joinSession() resolves, when a `const`
// would still be in its temporal dead zone.
const joined = {};
// --- Automatic surfacing (the cross-project "no extra work" path) ---
//
// An extension can't open its own canvas, but a tool hook CAN see the agent's
// working directory and inject guidance the model reads. So after the agent runs
// tests, we detect the freshly written results file and tell the agent to open
// this canvas with that file. The agent opens it (which it's allowed to do) and
// the server's directory watcher takes over for live refresh on re-runs.
// Tool-argument text that indicates a test run (covers common ecosystems).
const TEST_CMD_RE = /\b(dotnet\s+test|vstest|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|jest|vitest|mvn\s+(test|verify)|gradle\w*\s+test|pytest|py\.test|go\s+test|cargo\s+test|rspec|phpunit|ctest)\b|--junitxml|--?logger[= ]?["']?trx|surefire|failsafe|\.trx\b/i;
// Per-working-dir key of the last results file we surfaced, so we don't nag.
const lastSurfaced = new Map();
// Newest valid results file under a directory, written since `sinceMs` (used by
// the tool hook after a test run).
function scanForRecentResults(rootDir, sinceMs) {
    return scanForResults(rootDir, { sinceMs })[0]?.path ?? null;
}
// Tool hook body (shared by success + failure): if the tool was a test run and a
// fresh results file exists in the working dir, return guidance telling the agent
// to open this canvas with that file. Returns undefined when there's nothing to do.
function surfaceIfResults(input) {
    try {
        const argText = JSON.stringify(input?.toolArgs ?? "");
        if (!TEST_CMD_RE.test(argText))
            return undefined;
        const root = input?.workingDirectory;
        if (!root || !existsSync(root))
            return undefined;
        const abs = scanForRecentResults(root, Date.now() - 120000);
        if (!abs)
            return undefined;
        const key = `${abs}:${statSync(abs).mtimeMs}`;
        if (lastSurfaced.get(root) === key)
            return undefined; // already told the agent
        lastSurfaced.set(root, key);
        console.error(`[example-canvas] hook surfacing results: ${abs}`);
        return {
            additionalContext: `The test run just produced a results file at "${abs}". ` +
                `Immediately open the "Test Results" canvas (canvasId "${CANVAS_ID}") with ` +
                `input { "resultsFile": ${JSON.stringify(abs)} } so the user sees the results UI. ` +
                `Open it right away without asking, and don't print the results as text instead.`,
        };
    }
    catch (err) {
        console.error("[example-canvas] surfaceIfResults error:", err instanceof Error ? err.message : err);
        return undefined;
    }
}
// When the compiled view (dist/src/view.js), the shared stylesheet
// (dist/src/styles.js) or the Preact bundle (dist/client/app.js) changes on
// disk, reload every open panel so UI edits appear with no extension reload.
for (const path of [VIEW_PATH, STYLES_PATH, CLIENT_BUNDLE]) {
    watchFile(path, { interval: 400 }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs)
            for (const h of servers.values())
                h.reload();
    });
}
joined.session = await joinSession({
    canvases: [
        createCanvas({
            id: CANVAS_ID,
            displayName: "Test Results",
            description: "A visual test-results canvas that renders .NET TRX and JUnit XML runs. " +
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
                    resultsFile: {
                        type: "string",
                        description: "Absolute path to a test-results file (.trx or JUnit .xml) generated by the " +
                            "test run. The canvas loads it and watches its folder for re-runs.",
                    },
                    resultsDir: {
                        type: "string",
                        description: "Absolute path to a folder containing test-results files. The newest valid " +
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
                            status: { type: "string", enum: ["pass", "fail", "skip"], description: "The test outcome" },
                            durationMs: { type: "number", description: "How long the test took, in milliseconds" },
                            message: { type: "string", description: "Failure message or output (shown for failing tests)" },
                        },
                        required: ["name", "status"],
                    },
                    handler: async (ctx) => {
                        const handle = servers.get(ctx.instanceId);
                        if (!handle)
                            return { success: false, error: "canvas not open" };
                        const result = asResultInput(ctx.input);
                        if (!result) {
                            return { success: false, error: "invalid input: expected an object with a non-empty string 'name'" };
                        }
                        const total = handle.addResult(result);
                        return { success: true, totalResults: total };
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
                        const handle = servers.get(ctx.instanceId);
                        if (!handle)
                            return { success: false, error: "canvas not open" };
                        const raw = ctx.input?.results;
                        if (!Array.isArray(raw)) {
                            return { success: false, error: "invalid input: 'results' must be an array of test results" };
                        }
                        // Keep the well-formed entries and tell the agent how many
                        // were unusable, rather than failing the whole batch.
                        const results = raw.map(asResultInput).filter((r) => r !== null);
                        const skipped = raw.length - results.length;
                        const total = handle.setResults(results);
                        return skipped > 0
                            ? { success: true, totalResults: total, skipped, warning: `${skipped} entr${skipped === 1 ? "y" : "ies"} skipped: missing a valid 'name'` }
                            : { success: true, totalResults: total };
                    },
                },
                {
                    name: "clear_all",
                    description: "Remove all test results",
                    inputSchema: { type: "object", properties: {} },
                    handler: async (ctx) => {
                        const handle = servers.get(ctx.instanceId);
                        if (!handle)
                            return { success: false, error: "canvas not open" };
                        handle.clearResults();
                        return { success: true, message: "All results cleared" };
                    },
                },
                {
                    name: "get_results",
                    description: "Get the current list of all test results with a summary",
                    inputSchema: { type: "object", properties: {} },
                    handler: async (ctx) => {
                        const handle = servers.get(ctx.instanceId);
                        const results = handle ? handle.getResults() : [];
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
                // Non-string resultsFile/resultsDir are dropped here so they
                // never reach existsSync()/path joins; the canvas then opens
                // empty instead of throwing during open. ctx.input may also be
                // absent entirely — both seed fields are optional.
                const seed = asOpenInput(ctx.input);
                let handle = servers.get(ctx.instanceId);
                if (!handle) {
                    // Seed from the agent's input (file or dir) before the page
                    // connects, so the first SSE payload already has the right data.
                    handle = await createResultsServer({
                        title,
                        port: FIXED_PORT,
                        resultsFile: seed.resultsFile,
                        resultsDir: seed.resultsDir,
                        // The server composed this prompt from its own results;
                        // nothing here is supplied by the page.
                        onAsk: async ({ prompt }) => {
                            if (!joined.session)
                                throw new Error("session not joined yet");
                            await joined.session.send({ prompt });
                        },
                    });
                    servers.set(ctx.instanceId, handle);
                }
                else {
                    // Re-open may point at a new file; re-seed and push it live.
                    handle.loadInput(seed);
                }
                return { title, url: handle.url };
            },
            onClose: async (ctx) => {
                const handle = servers.get(ctx.instanceId);
                if (handle) {
                    servers.delete(ctx.instanceId);
                    await handle.close();
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
