// The benchmark runs on its own config so `npm run test:e2e` stays fast and
// deterministic: one worker, no retries, no parallelism -- a timing run shares
// the machine with nobody.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.bench\.spec\.ts|perf\.spec\.ts/,
  outputDir: "../test-results/bench",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
