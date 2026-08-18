// SDK-free HTTP server for the Test Results canvas: serves the view, streams
// updates over SSE, and exposes the shared ResultsStore over loopback.
//
// All the state (file discovery, parsing, watching, mutation) lives in
// ./core/store.ts so the VS Code host can reuse it without an HTTP hop; this
// module is only the Copilot-canvas transport around it.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync, statSync } from "node:fs";
import { composeAskPrompt } from "./ask.js";
import { randomBytes } from "node:crypto";
import { ResultsStore } from "./core/store.js";
import type { TestResult } from "./types.js";

// Re-exported because extension.ts, the tests and the e2e suite already import
// them from here; the implementations moved into the shared store.
export { RESULT_EXTS, looksLikeResults, newestResultsFileIn, normalizeStatus } from "./core/store.js";
export type { ResultInput } from "./core/store.js";
import type { ResultInput } from "./core/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VIEW_PATH = join(__dirname, "view.js");
const STYLES_PATH = join(__dirname, "styles.js");
const CLIENT_BUNDLE = join(__dirname, "..", "client", "app.js");

// Re-imported only when the file actually changes, so edits show up on a canvas
// refresh without leaking one cached ESM module per request. The stylesheet is
// tracked separately from the shell: view.js imports it statically, so a
// CSS-only edit would otherwise stay pinned to the first cached copy.
async function freshImport<T>(path: string, cache: { mod?: T; mtimeMs: number }): Promise<T> {
    const mtimeMs = statSync(path).mtimeMs;
    if (!cache.mod || mtimeMs !== cache.mtimeMs) {
        cache.mod = (await import(`${pathToFileURL(path).href}?t=${mtimeMs}`)) as T;
        cache.mtimeMs = mtimeMs;
    }
    return cache.mod;
}
const viewCache: { mod?: typeof import("./view.js"); mtimeMs: number } = { mtimeMs: -1 };
const stylesCache: { mod?: typeof import("./styles.js"); mtimeMs: number } = { mtimeMs: -1 };

async function renderShell(title: string, askToken: string): Promise<string> {
    const view = await freshImport<typeof import("./view.js")>(VIEW_PATH, viewCache);
    const styles = await freshImport<typeof import("./styles.js")>(STYLES_PATH, stylesCache);
    return view.renderShell(title, askToken, styles.THEME_COPILOT + styles.BASE_CSS);
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

export interface ResultsServerOptions {
    resultsFile?: string;
    resultsDir?: string;
    title?: string;
    port?: number;
    watch?: boolean;
    alsoRegister?: string[];
    // Called when the user clicks "Ask agent" on a row. Injected rather than
    // imported so this module stays host-free: the extension passes a closure
    // over session.send, tests pass a spy.
    onAsk?: (req: AskRequest) => void | Promise<void>;
}

// What POST /ask hands to the host once the row has been resolved server-side.
export interface AskRequest {
    prompt: string;
    test: TestResult;
}

// The handle returned by createResultsServer; the type the SDK glue stores per canvas.
export type ResultsServerHandle = Awaited<ReturnType<typeof createResultsServer>>;

// Start one Test Results server. Returns a handle with the URL plus methods the
// SDK actions (and tests) use to mutate state and tear down.
export async function createResultsServer(options: ResultsServerOptions = {}) {
    // watch=false disables the results-dir watcher.
    const { resultsFile, resultsDir, title = "Test Results", port = 0, watch: watchEnabled = true, onAsk } = options;

    // The server listens on a fixed, guessable port, so /ask -- which can drive
    // the user's agent -- is gated on a secret minted per instance and handed
    // only to the page this server rendered.
    const askToken = randomBytes(16).toString("hex");

    const store = new ResultsStore({
        rootDir: EXTENSION_ROOT,
        resultsFile,
        resultsDir,
        title,
        watch: watchEnabled,
        alsoRegister: options.alsoRegister,
    });

    const clients = new Set<ServerResponse>();

    function statePayload() {
        return JSON.stringify(store.state());
    }
    function broadcast() {
        const data = statePayload();
        for (const res of clients) res.write(`data: ${data}\n\n`);
    }
    function reload() {
        for (const res of clients) res.write(`event: reload\ndata: 1\n\n`);
    }
    // Every store mutation — including one made by the directory watcher — reaches
    // the page through here.
    const unsubscribe = store.onChange(broadcast);

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
        const test = store.getResults()[payload.index];
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
            res.end(JSON.stringify({ files: store.state().files, current: store.currentFile() }));
            return;
        }
        if (url.startsWith("/load")) {
            const u = new URL(url, "http://localhost");
            const name = u.searchParams.get("file") || "";
            if (!store.loadNamed(name)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "unknown file" }));
                return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, file: name }));
            return;
        }
        if (url === "/ask" || url.startsWith("/ask?")) {
            await handleAsk(req, res);
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
        currentFile: () => store.currentFile(),
        getResults: () => store.getResults(),
        setResults: (list: ResultInput[]) => store.setResults(list),
        addResult: (t: ResultInput) => store.addResult(t),
        clearResults: () => store.clearResults(),
        loadNamed: (name: string) => store.loadNamed(name),
        // Re-seed from fresh open input (e.g. a re-open pointing at a new file).
        loadInput: (input: { resultsFile?: string; resultsDir?: string } = {}) => store.loadInput(input),
        broadcast,
        reload,
        async close() {
            unsubscribe();
            store.dispose();
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
