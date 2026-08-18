// VS Code host for the Test Results UI.
//
// Everything here is glue. The state (discovery, parsing, mutation) is the same
// ResultsStore the Copilot canvas uses, and the UI is the same Preact bundle;
// the only difference is the transport — a webview postMessage channel instead
// of HTTP + SSE — which the client reaches through the "@bridge" alias.
//
// The view is a WebviewViewProvider so it docks in the sidebar like Copilot Chat
// rather than opening as an editor tab.

import * as vscode from "vscode";
import { ResultsStore, looksLikeResults } from "../../src/core/store.js";
import { composeAskPrompt } from "../../src/ask.js";
import { THEME_VSCODE, BASE_CSS } from "../../src/styles.js";
import type { CanvasState } from "../../src/types.js";

const VIEW_ID = "testResults.view";
const EXCLUDE = "**/node_modules/**";

// Messages the webview sends us.
type Incoming =
    | { type: "ready" }
    | { type: "load"; file: string }
    | { type: "ask"; id: number; index: number; name: string };

function config<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration("testResults").get<T>(key) ?? fallback;
}

function nonce(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

class TestResultsViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly store: ResultsStore,
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
        };
        view.webview.html = this.html(view.webview);
        view.webview.onDidReceiveMessage((msg: Incoming) => this.onMessage(msg));
        view.onDidDispose(() => {
            this.view = undefined;
        });
    }

    post(state: CanvasState): void {
        void this.view?.webview.postMessage({ type: "state", state });
    }

    private async onMessage(msg: Incoming): Promise<void> {
        if (msg.type === "ready") {
            this.post(this.store.state());
            return;
        }
        if (msg.type === "load") {
            this.store.loadNamed(msg.file);
            return;
        }
        if (msg.type === "ask") {
            const ok = await this.ask(msg.index, msg.name);
            void this.view?.webview.postMessage({ type: "ask:result", id: msg.id, ok });
        }
    }

    // The webview sends a row reference, never prompt text: the message is built
    // here from our own results, and `name` catches a click that raced a refresh.
    private async ask(index: number, name: string): Promise<boolean> {
        const test = this.store.getResults()[index];
        if (!test || test.name !== name) return false;
        try {
            await vscode.commands.executeCommand("workbench.action.chat.open", { query: composeAskPrompt(test) });
            return true;
        } catch (err) {
            console.error("[test-results] could not open chat:", err);
            return false;
        }
    }

    private html(webview: vscode.Webview): string {
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "client", "app.js"));
        const n = nonce();
        // Scripts are allowed only by nonce; the stylesheet is inlined from
        // src/styles.ts, which is why style-src needs 'unsafe-inline'.
        const csp = [
            "default-src 'none'",
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${n}'`,
        ].join("; ");
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Test Results</title>
<style>${THEME_VSCODE}${BASE_CSS}</style>
</head>
<body>
  <div id="app"></div>
  <script nonce="${n}" src="${script}"></script>
</body>
</html>`;
    }
}

// Newest results file in the workspace, so the view has something to show as
// soon as it opens.
async function findResultFiles(): Promise<vscode.Uri[]> {
    const glob = config("watchGlob", "**/*.{trx,xml}");
    return vscode.workspace.findFiles(glob, EXCLUDE, 500);
}

async function isResults(uri: vscode.Uri): Promise<boolean> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return looksLikeResults(Buffer.from(bytes.slice(0, 8192)).toString("utf8"));
    } catch {
        return false;
    }
}

async function newestResults(uris: vscode.Uri[]): Promise<vscode.Uri | undefined> {
    let best: vscode.Uri | undefined;
    let bestTime = -1;
    for (const uri of uris) {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.mtime > bestTime && await isResults(uri)) {
                best = uri;
                bestTime = stat.mtime;
            }
        } catch { /* vanished between find and stat */ }
    }
    return best;
}

export function activate(context: vscode.ExtensionContext): void {
    // watch:false because VS Code's own file watcher (below) already honours the
    // user's exclude settings and reaches files this store never walks.
    const store = new ResultsStore({ rootDir: context.extensionUri.fsPath, title: "Test Results", watch: false });
    const provider = new TestResultsViewProvider(context.extensionUri, store);

    context.subscriptions.push(
        { dispose: () => store.dispose() },
        { dispose: store.onChange((state) => provider.post(state)) },
        vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
            // Keep the list, filters and expansion state while the view is hidden.
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    const reveal = () => vscode.commands.executeCommand(`${VIEW_ID}.focus`);

    const show = async (uri: vscode.Uri) => {
        store.register([uri.fsPath]);
        store.loadInput({ resultsFile: uri.fsPath });
        await reveal();
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("testResults.open", async () => {
            await reveal();
        }),
        vscode.commands.registerCommand("testResults.openFile", async (uri?: vscode.Uri) => {
            const target = uri ?? (await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { "Test results": ["trx", "xml"] },
            }))?.[0];
            if (target) await show(target);
        }),
    );

    // A test run finishing is just a results file appearing or changing, so one
    // watcher covers both "npm test" in a terminal and a task-driven run.
    const watcher = vscode.workspace.createFileSystemWatcher(config("watchGlob", "**/*.{trx,xml}"));
    let pending: ReturnType<typeof setTimeout> | undefined;
    const onResultsFile = (uri: vscode.Uri) => {
        if (uri.fsPath.includes("node_modules")) return;
        clearTimeout(pending);
        // A writer can produce several change events for one save.
        pending = setTimeout(async () => {
            if (!await isResults(uri)) return;
            store.register([uri.fsPath]);
            store.loadInput({ resultsFile: uri.fsPath });
            if (config("autoReveal", true)) await reveal();
        }, 400);
    };
    watcher.onDidCreate(onResultsFile, null, context.subscriptions);
    watcher.onDidChange(onResultsFile, null, context.subscriptions);
    context.subscriptions.push(watcher);

    // Lets the agent put a run on screen and read its outcome back.
    context.subscriptions.push(vscode.lm.registerTool<{ file?: string }>("show_test_results", {
        async invoke(options) {
            const wanted = options.input?.file;
            const uri = wanted
                ? vscode.Uri.file(wanted)
                : await newestResults(await findResultFiles());
            if (uri) await show(uri);
            const results = store.getResults();
            if (!results.length) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart("No test results were found in this workspace."),
                ]);
            }
            const failed = results.filter((t) => t.status === "fail");
            const summary = [
                `Showing ${store.currentFile()}: ${results.length} tests, ` +
                `${results.filter((t) => t.status === "pass").length} passed, ` +
                `${failed.length} failed, ${results.filter((t) => t.status === "skip").length} skipped.`,
                ...failed.slice(0, 20).map((t) => `FAIL ${t.name}${t.message ? `: ${t.message.split("\n")[0]}` : ""}`),
            ].join("\n");
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(summary)]);
        },
    }));

    // Populate the file picker and seed the view, without blocking activation.
    void (async () => {
        const uris = await findResultFiles();
        store.register(uris.map((u) => u.fsPath));
        const newest = await newestResults(uris);
        if (newest) store.loadInput({ resultsFile: newest.fsPath });
    })();
}

export function deactivate(): void { /* everything is in context.subscriptions */ }
