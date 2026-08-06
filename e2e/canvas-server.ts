// Boots the real canvas server over an e2e/fixtures file
// and opens it in the browser. Specs import test/expect/get_fixture_path/openCanvas here.
import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createResultsServer } from "../dist/src/server.js";
import type { ResultsServerHandle, ResultsServerOptions } from "../dist/src/server.js";

const FIXTURES_FOLDER_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// Absolute path to a fixture file.
export const get_fixture_path = (name: string): string => join(FIXTURES_FOLDER_PATH, name);

// Navigate to the canvas and wait for its SSE stream (/events) to open before
// asserting.
export async function openCanvas(page: Page, server: ResultsServerHandle): Promise<void> {
  const connected = page.waitForResponse((r) => r.url().includes("/events"));
  await page.goto(server.url);
  await connected;
}

type MakeServer = (opts?: ResultsServerOptions) => Promise<ResultsServerHandle>;

// makeServer(opts): boots a results server on an ephemeral port; closes every
// server it made when the test ends.
export const test = base.extend<{ makeServer: MakeServer }>({
    // Playwright reads the destructured names to resolve fixture dependencies;
    // an empty pattern is how you declare "no dependencies".
    // eslint-disable-next-line no-empty-pattern
  makeServer: async ({}, use) => {
    const started: ResultsServerHandle[] = [];
    await use(async (opts: ResultsServerOptions = {}) => {
      // Coverage is opt-in for specs. The server discovers a report near the
      // results file, and e2e/fixtures/coverage/ holds several -- so leaving it
      // on would silently attach a coverage report to every unrelated spec (and
      // shell out to git on each one). Coverage specs pass `coverage: true`.
      const s = await createResultsServer({ port: 0, watch: false, coverage: false, ...opts });
      started.push(s);
      return s;
    });
    for (const s of started) await s.close();
  },
});

export { expect };
