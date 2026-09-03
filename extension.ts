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
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { watchFile, existsSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { createResultsServer, looksLikeResults, RESULT_EXTS } from "./src/server.js";
import { readHead } from "./src/head.js";
import type { ResultsServerHandle, ResultInput } from "./src/server.js";
import type { AgentTestRef } from "./src/diff/relevance.js";
import { discoverCoverageFor, findProjectRoot, suggestCoverageCommand } from "./src/coverage/index.js";
// Action/open input reaches handlers typed as `unknown`; narrow it here first.
import { asResultInput, asOpenInput, asFilesInput, asAgentTestRef } from "./src/validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEW_PATH = join(__dirname, "src", "view.js");
const CLIENT_BUNDLE = join(__dirname, "client", "app.js");

// The canvas id declared below (used when programmatically opening the panel).
const CANVAS_ID = "example-canvas";

// Fixed port for a stable, bookmarkable browser URL (the server falls back to a
// random port if this one is already taken).
const FIXED_PORT = 4830;

// One server per open canvas instance: instanceId -> handle from createResultsServer.
const servers = new Map<string, ResultsServerHandle>();

// The joined session, reachable from canvas handlers so a panel can post a
// message back into its own conversation. Held in an object rather than a plain
// binding because the host re-opens already-open panels as soon as the canvas is
// declared -- which can happen before joinSession() resolves, when a `const`
// would still be in its temporal dead zone.
const joined: { session?: Awaited<ReturnType<typeof joinSession>> } = {};

// --- Automatic surfacing (the cross-project "no extra work" path) ---
//
// An extension can't open its own canvas, but a tool hook CAN see the agent's
// working directory and inject guidance the model reads. So after the agent runs
// tests, we detect the freshly written results file and tell the agent to open
// this canvas with that file. The agent opens it (which it's allowed to do) and
// the server's directory watcher takes over for live refresh on re-runs.

// Tool-argument text that indicates a test run (covers common ecosystems).
const TEST_CMD_RE =
    /\b(dotnet\s+test|vstest|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|jest|vitest|mvn\s+(test|verify)|gradle\w*\s+test|pytest|py\.test|go\s+test|cargo\s+test|nextest|rspec|phpunit|ctest|prove|dart\s+test|flutter\s+test)\b|--junitxml|--?logger[= ]?["']?trx|surefire|failsafe|\.trx\b/i;

// Per-working-dir key of the last results file we surfaced, so we don't nag.
const lastSurfaced = new Map<string, string>();

// Bounded search for the valid results files written under a directory since
// `sinceMs` (used by the tool hook after a test run). Depth- and budget-capped so
// it stays cheap even in large repos, and skips build/vcs/dependency noise.
//
// All of them, not just the newest: one `dotnet test` over a solution writes one
// TRX per test project, and surfacing only the newest would hide the rest.
// Returned newest-first, so the single-file case still resolves to the same file
// it always did.
function scanForRecentResults(rootDir: string, sinceMs: number): string[] {
    const IGNORE = new Set(["node_modules", ".git", ".hg", ".svn", "bin", "obj", "dist", "out", ".vs", ".idea", ".venv"]);
    const found: { path: string; mtimeMs: number }[] = [];
    let budget = 4000;
    const stack: { dir: string; depth: number }[] = [{ dir: rootDir, depth: 0 }];
    while (stack.length) {
        const { dir, depth } = stack.pop()!;
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const ent of entries) {
            if (--budget < 0) return ordered(found);
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
                if (st.mtimeMs <= sinceMs) continue;
                if (!looksLikeResults(readHead(abs))) continue;
                found.push({ path: abs, mtimeMs: st.mtimeMs });
            } catch { /* ignore unreadable */ }
        }
    }
    return ordered(found);
}

// Newest first, then by path: directory iteration order is not guaranteed, and
// the guidance (and the dedupe key built from it) has to be stable across runs.
function ordered(found: { path: string; mtimeMs: number }[]): string[] {
    return found
        .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
        .map((f) => f.path);
}

// Tool hook body (shared by success + failure): if the tool was a test run and a
// fresh results file exists in the working dir, return guidance telling the agent
// to open this canvas with that file. Returns undefined when there's nothing to do.
function surfaceIfResults(input: { toolArgs?: unknown; workingDirectory?: string }): { additionalContext: string } | undefined {
    try {
        const argText = JSON.stringify(input?.toolArgs ?? "");
        if (!TEST_CMD_RE.test(argText)) return undefined;
        const root = input?.workingDirectory;
        if (!root || !existsSync(root)) return undefined;
        const found = scanForRecentResults(root, Date.now() - 120000);
        if (!found.length) return undefined;
        // Newest first, so this is the file the hook has always surfaced.
        const abs = found[0];
        const merged = found.length > 1;

        // The coverage report the same run wrote, if any. Discovery is bounded
        // and only runs once we already know a test run happened.
        //
        // A merged run never names one: it would be a single project's report
        // standing in for all of them. The canvas attaches coverage itself when
        // exactly one source owns a report, so all the hook needs to know is
        // whether ANY did — that is what decides the suggestion below.
        let coverageFile: string | null = null;
        let hasCoverage = false;
        let projectRoot: string | undefined;
        try {
            projectRoot = findProjectRoot(dirname(abs));
            if (merged) {
                // No projectRoot on purpose: with it, every project finds some
                // report somewhere in the repo, usually another project's.
                hasCoverage = found.some((f) => Boolean(discoverCoverageFor(f)));
            } else {
                coverageFile = discoverCoverageFor(abs, projectRoot);
                hasCoverage = Boolean(coverageFile);
            }
        } catch { /* coverage is best-effort; results still surface */ }

        // Keyed on the coverage file too: a re-run that adds coverage to an
        // otherwise unchanged report is worth surfacing again.
        const key = `${found.join("|")}:${statSync(abs).mtimeMs}:${coverageFile ?? (hasCoverage ? "some" : "")}`;
        if (lastSurfaced.get(root) === key) return undefined; // already told the agent
        lastSurfaced.set(root, key);
        console.error(`[example-canvas] hook surfacing results: ${found.join(", ")}${coverageFile ? ` (+ coverage ${coverageFile})` : ""}`);

        // projectRoot is passed on rather than left to be inferred: the panel
        // would otherwise guess it from the coverage report, which in a monorepo
        // can name a different package than the run. A merged run names neither
        // it nor a coverage file: both are derived from the newest file alone, so
        // they would hand the whole run one member project's identity.
        const open: Record<string, string | string[]> = merged
            ? { name: basename(root), resultsFiles: found }
            : { resultsFile: abs };
        if (!merged && coverageFile) open.coverageFile = coverageFile;
        if (!merged && projectRoot) open.projectRoot = projectRoot;
        const openInput = JSON.stringify(open);

        // With no coverage report, name the command that would produce one --
        // most runners collect nothing unless asked, and the panel is far more
        // useful once it can show which code the run actually exercised.
        const suggestion = hasCoverage ? "" : (() => {
            const hint = suggestCoverageCommand(projectRoot, abs);
            const alt = hint.alternative ? ` or, for ${hint.alternative.ecosystem}, \`${hint.alternative.command}\`` : "";
            return ` This run produced no code-coverage report. After opening the canvas, offer to re-run the tests with coverage collected (${hint.ecosystem}: \`${hint.command}\`, which writes ${hint.outputHint}${alt}) so the panel can also show which code is covered.`;
        })();

        const headline = merged
            ? `The test run produced ${found.length} results files: ${found.map((f) => `"${f}"`).join(", ")}. ` +
              `Immediately open the "Test Results" canvas (canvasId "${CANVAS_ID}") with ` +
              `input ${openInput} so the user sees all of them merged into one run. ` +
              `Open it right away without asking, don't pick just one of the files, and don't print the results as text instead.`
            : `The test run just produced a results file at "${abs}". ` +
              `Immediately open the "Test Results" canvas (canvasId "${CANVAS_ID}") with ` +
              `input ${openInput} so the user sees the results UI. ` +
              `Open it right away without asking, and don't print the results as text instead.`;

        return { additionalContext: headline + suggestion };
    } catch (err) {
        console.error("[example-canvas] surfaceIfResults error:", err instanceof Error ? err.message : err);
        return undefined;
    }
}

// When the compiled view (dist/src/view.js) or the Preact bundle
// (dist/client/app.js) changes on disk, reload every open panel so UI edits
// appear with no extension reload.
watchFile(VIEW_PATH, { interval: 400 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) for (const h of servers.values()) h.reload();
});
watchFile(CLIENT_BUNDLE, { interval: 400 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) for (const h of servers.values()) h.reload();
});

joined.session = await joinSession({
    canvases: [
        createCanvas({
            id: CANVAS_ID,
            displayName: "Test Results",
            description:
                "A visual test-results and code-coverage canvas that renders .NET TRX, JUnit/NUnit/" +
                "xUnit.net/TestNG/CTest XML, TAP, CTRF, Allure and go/Dart/Rust JSON runs. " +
                "IMPORTANT: after running a project's tests, open this canvas and pass the " +
                "results file as input so it appears automatically — set `resultsFile` to the " +
                "absolute path of the generated .trx/.xml, or `resultsDir` to the folder that " +
                "contains it (the newest results file is picked). If the run wrote SEVERAL results " +
                "files (a .NET solution writes one TRX per test project), pass them all as " +
                "`resultsFiles` with a `name` for the run instead of picking one and losing the " +
                "rest. If the run also produced a " +
                "coverage report (Cobertura, LCOV or JaCoCo), pass `coverageFile` too — otherwise " +
                "the canvas discovers it next to the results file. The canvas then watches those " +
                "folders and refreshes live over SSE on every re-run — no need to reopen it. " +
                "Shows pass/fail/skip status, per-test duration, failure messages, a summary, and " +
                "a coverage view with which lines are covered, how much of the newly changed code " +
                "is tested, and the uncovered code most worth testing. " +
                "It also has a diff mode that flags which tests in the run are new, which the " +
                "change modified, and which it may have impacted. " +
                "Actions can also report individual results, load a full batch, or clear them.",
            inputSchema: {
                type: "object",
                properties: {
                    resultsFile: {
                        type: "string",
                        description:
                            "Absolute path to a test-results file (.trx, JUnit/NUnit/xUnit/TestNG/CTest " +
                            ".xml, .tap, or a CTRF/Allure/go/Dart/Rust .json/.jsonl) generated by the " +
                            "test run. The canvas loads it and watches its folder for re-runs.",
                    },
                    resultsDir: {
                        type: "string",
                        description:
                            "Absolute path to a folder containing test-results files. The newest valid " +
                            "report is loaded (an Allure results folder is merged whole) and the folder " +
                            "is watched for re-runs. Ignored if resultsFile is given and valid.",
                    },
                    resultsFiles: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Absolute paths to several test-results files, merged into one run. Use this " +
                            "for a repo whose test suite writes one report per project (e.g. a .NET " +
                            "solution with several test projects) instead of opening one file and losing " +
                            "the rest. Takes precedence over resultsFile/resultsDir.",
                    },
                    name: {
                        type: "string",
                        description:
                            "Display name for a merged run, e.g. \"AITestAgentTests\". Only meaningful " +
                            "alongside resultsFiles.",
                    },
                    coverageFile: {
                        type: "string",
                        description:
                            "Absolute path to a code-coverage report produced by the same run: Cobertura " +
                            "XML (dotnet test --collect:\"XPlat Code Coverage\", coverage.py), LCOV " +
                            "(vitest/jest/c8/nyc), or JaCoCo XML (Maven/Gradle). Optional — when omitted " +
                            "the canvas looks for one next to the results file.",
                    },
                    coverageDir: {
                        type: "string",
                        description:
                            "Absolute path to a folder containing a coverage report. The newest valid " +
                            "report is loaded and the folder is watched for re-runs. Ignored if " +
                            "coverageFile is given and valid.",
                    },
                    projectRoot: {
                        type: "string",
                        description:
                            "Absolute path to the repository or package the coverage report describes. " +
                            "Optional — when omitted it is inferred from the results file. Pass it when " +
                            "the tests live in a sub-package of a monorepo, so source files and the " +
                            "changed-lines diff resolve against the right project.",
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
                        if (!handle) return { success: false, error: "canvas not open" };
                        const result = asResultInput(ctx.input);
                        if (!result) {
                            return { success: false, error: "invalid input: expected an object with a non-empty string 'name'" };
                        }
                        const written = handle.addResult(result);
                        if (!written.ok) return { success: false, error: written.error };
                        return { success: true, totalResults: written.total };
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
                        if (!handle) return { success: false, error: "canvas not open" };
                        const raw = ctx.input?.results;
                        if (!Array.isArray(raw)) {
                            return { success: false, error: "invalid input: 'results' must be an array of test results" };
                        }
                        // Keep the well-formed entries and tell the agent how many
                        // were unusable, rather than failing the whole batch.
                        const results = raw.map(asResultInput).filter((r): r is ResultInput => r !== null);
                        const skipped = raw.length - results.length;
                        const written = handle.setResults(results);
                        if (!written.ok) return { success: false, error: written.error };
                        return skipped > 0
                            ? { success: true, totalResults: written.total, skipped, warning: `${skipped} entr${skipped === 1 ? "y" : "ies"} skipped: missing a valid 'name'` }
                            : { success: true, totalResults: written.total };
                    },
                },
                {
                    name: "clear_all",
                    description: "Remove all test results",
                    inputSchema: { type: "object", properties: {} },
                    handler: async (ctx) => {
                        const handle = servers.get(ctx.instanceId);
                        if (!handle) return { success: false, error: "canvas not open" };
                        const written = handle.clearResults();
                        if (!written.ok) return { success: false, error: written.error };
                        return { success: true, message: "All results cleared" };
                    },
                },
                {
                    name: "open_files",
                    description:
                        "Merge several test-results files into one run and show them as a single named " +
                        "group, e.g. open_files(name: \"AITestAgentTests\", files: [A.trx, B.trx, C.trx]). " +
                        "Use after a run that wrote one report per test project. Returns per-file counts " +
                        "so the merge can be verified.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "Display name for the merged run" },
                            files: {
                                type: "array",
                                items: { type: "string" },
                                description: "Absolute paths to the .trx/JUnit .xml files to merge",
                            },
                        },
                        required: ["files"],
                    },
                    handler: async (ctx) => {
                        const handle = servers.get(ctx.instanceId);
                        if (!handle) return { success: false, error: "canvas not open" };
                        // Non-string and over-cap entries are dropped before any
                        // path reaches the filesystem.
                        const { name, files } = asFilesInput(ctx.input);
                        if (!files.length) {
                            return { success: false, error: "invalid input: 'files' must be an array of file paths" };
                        }
                        const merged = handle.openFiles({ name, files });
                        if (!merged.ok) return { success: false, error: merged.error, skipped: merged.skipped };
                        return {
                            success: true,
                            name: handle.currentFile(),
                            total: merged.total,
                            sources: merged.sources,
                            ...(merged.skipped.length ? { skipped: merged.skipped } : {}),
                        };
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
                {
                    name: "set_impacted_tests",
                    description:
                        "Mark the tests a code change may affect. Use this to answer the canvas's " +
                        "\"which tests are impacted?\" request: read the changed files, decide which " +
                        "existing tests exercise that code, and report them here. The canvas already " +
                        "tags new and modified tests on its own — add the ones only reading the code " +
                        "reveals. Names must match the test names in the current run.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            tests: {
                                type: "array",
                                description: "The tests the change may affect",
                                items: {
                                    type: "object",
                                    properties: {
                                        name: { type: "string", description: "The test name, as it appears in the run" },
                                        className: { type: "string", description: "Its class or suite, if two tests share a name" },
                                        reason: { type: "string", description: "One short line on why this test is affected" },
                                    },
                                    required: ["name"],
                                },
                            },
                        },
                        required: ["tests"],
                    },
                    handler: async (ctx) => {
                        const handle = servers.get(ctx.instanceId);
                        if (!handle) return { success: false, error: "canvas not open" };
                        const raw = ctx.input?.tests;
                        if (!Array.isArray(raw)) {
                            return { success: false, error: "invalid input: 'tests' must be an array of test references" };
                        }
                        const refs = raw.map(asAgentTestRef).filter((r): r is AgentTestRef => r !== null);
                        const { matched, unmatched } = handle.markImpacted(refs);
                        // Naming the misses matters: a wrong name is silent otherwise,
                        // and the agent can retry with what the run actually calls it.
                        return unmatched.length > 0
                            ? { success: true, matched, unmatched, warning: `${unmatched.length} name(s) matched no test in the current run` }
                            : { success: true, matched };
                    },
                },
                {
                    name: "clear_impacted_tests",
                    description: "Remove the impact assessment previously reported with set_impacted_tests",
                    inputSchema: { type: "object", properties: {} },
                    handler: async (ctx) => {
                        const handle = servers.get(ctx.instanceId);
                        if (!handle) return { success: false, error: "canvas not open" };
                        handle.clearImpacted();
                        return { success: true, message: "Impact assessment cleared" };
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
                        name: seed.name,
                        resultsFile: seed.resultsFile,
                        resultsDir: seed.resultsDir,
                        resultsFiles: seed.resultsFiles,
                        coverageFile: seed.coverageFile,
                        coverageDir: seed.coverageDir,
                        projectRoot: seed.projectRoot,
                        // The server composed this prompt from its own results;
                        // nothing here is supplied by the page.
                        onAsk: async ({ prompt }) => {
                            if (!joined.session) throw new Error("session not joined yet");
                            await joined.session.send({ prompt });
                        },
                    });
                    servers.set(ctx.instanceId, handle);
                } else {
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
