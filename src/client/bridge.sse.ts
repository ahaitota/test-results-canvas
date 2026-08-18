// Copilot-canvas bridge: the page is served by src/server.ts over loopback, so
// state arrives on an SSE stream and commands go back as plain HTTP requests.
// Selected by the default build; see the "@bridge" alias in package.json.

import type { Bridge } from "./bridge";
import type { CanvasState } from "../types";

const win = window as unknown as { __INITIAL_TITLE__?: string; __ASK_TOKEN__?: string };
const ASK_TOKEN = win.__ASK_TOKEN__ || "";

export const bridge: Bridge = {
  initialTitle: win.__INITIAL_TITLE__ || "Test Results",

  subscribe(onState) {
    const source = new EventSource("/events");
    source.onmessage = (e) => {
      let next: CanvasState;
      try {
        next = JSON.parse(e.data);
      } catch {
        return;
      }
      onState(next);
    };
    // Emitted by the extension when a rebuilt view or bundle lands on disk.
    source.addEventListener("reload", () => location.reload());
    return () => source.close();
  },

  load(file) {
    fetch("/load?file=" + encodeURIComponent(file)).catch(() => {});
  },

  async requestFiles() {
    try {
      const res = await fetch("/files");
      return await res.json();
    } catch {
      return null;
    }
  },

  async ask(index, name) {
    try {
      const res = await fetch("/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ASK_TOKEN}` },
        body: JSON.stringify({ index, name }),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
