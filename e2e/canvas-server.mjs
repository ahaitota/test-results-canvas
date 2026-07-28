// Boots the real canvas server over an e2e/fixtures file
// and opens it in the browser. Specs import test/expect/fixture/openCanvas here.
import { test as base, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createResultsServer } from "../src/server.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// Absolute path to a fixture file.
export const fixture = (name) => join(FIX, name);

// Navigate to the canvas and wait for its SSE stream (/events) to open before
// asserting.
export async function openCanvas(page, server) {
  const connected = page.waitForResponse((r) => r.url().includes("/events"));
  await page.goto(server.url);
  await connected;
}

// makeServer(opts): boots a results server on an ephemeral port; closes every
// server it made when the test ends.
export const test = base.extend({
  makeServer: async ({}, use) => {
    const started = [];
    await use(async (opts = {}) => {
      const s = await createResultsServer({ port: 0, watch: false, ...opts });
      started.push(s);
      return s;
    });
    for (const s of started) await s.close();
  },
});

export { expect };
