// VS Code bridge: the webview has no network access to the extension, so state
// and commands travel over the postMessage channel that VS Code opens between
// the two. Selected by the "@bridge" alias in the build:client:vscode script.

import type { Bridge } from "../../../src/client/bridge";
import type { CanvasState } from "../../../src/types";

// Injected by VS Code into every webview; can only be called once per page.
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

type Incoming =
  | { type: "state"; state: CanvasState }
  | { type: "ask:result"; id: number; ok: boolean };

const vscode = acquireVsCodeApi();

// Resolvers for in-flight ask() calls, keyed by the id we sent.
const pendingAsks = new Map<number, (ok: boolean) => void>();
let nextAskId = 1;

window.addEventListener("message", (event: MessageEvent<Incoming>) => {
  const msg = event.data;
  if (msg?.type !== "ask:result") return;
  pendingAsks.get(msg.id)?.(msg.ok);
  pendingAsks.delete(msg.id);
});

export const bridge: Bridge = {
  initialTitle: "Test Results",

  subscribe(onState) {
    const listener = (event: MessageEvent<Incoming>) => {
      if (event.data?.type === "state") onState(event.data.state);
    };
    window.addEventListener("message", listener);
    // The extension holds the state; ask for it now because the first push may
    // have happened while this script was still loading.
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  },

  load(file) {
    vscode.postMessage({ type: "load", file });
  },

  // The extension re-pushes state whenever the file list changes, so there is
  // nothing to re-fetch on focus.
  async requestFiles() {
    return null;
  },

  ask(index, name) {
    const id = nextAskId++;
    return new Promise<boolean>((resolve) => {
      pendingAsks.set(id, resolve);
      vscode.postMessage({ type: "ask", id, index, name });
      // The host always replies, but never leave a row spinning forever.
      setTimeout(() => {
        if (pendingAsks.delete(id)) resolve(false);
      }, 10000);
    });
  },
};
