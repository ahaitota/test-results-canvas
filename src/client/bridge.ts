// The one seam between the shared UI and its host.
//
// The UI never talks to a transport directly: it imports "@bridge", and the
// build picks an implementation with esbuild's --alias flag —
// bridge.sse.ts for the Copilot canvas (EventSource + fetch over loopback),
// vscode/src/client/bridge.vscode.ts for the VS Code webview (postMessage).
// Keeping this file type-only means neither implementation is ever bundled twice.

import type { CanvasState } from "../types";

export interface Bridge {
  // Shown before the first state arrives.
  initialTitle: string;
  // Starts the feed; returns an unsubscribe.
  subscribe(onState: (state: CanvasState) => void): () => void;
  // Switch the panel to another known results file.
  load(file: string): void;
  // Re-list the selectable files, or null when the host keeps the list current
  // on its own and there is nothing to re-fetch.
  requestFiles(): Promise<{ files: string[]; current?: string } | null>;
  // Ask the agent about one row, identified by payload position; `name` lets the
  // host reject a click that raced a refresh.
  ask(index: number, name: string): Promise<boolean>;
}
