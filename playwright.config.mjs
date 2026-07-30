import { defineConfig, devices } from "@playwright/test";

// Console list, HTML report and JUnit file; GitHub annotations on CI.
const reporter = [
  ["list"],
  ["html", { outputFolder: "playwright-report", open: "never" }],
  ["junit", { outputFile: "test-results/e2e-junit.xml" }],
];
if (process.env.CI) reporter.push(["github"]);

// Each spec starts its own server, so there is no global webServer/baseURL.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/e2e",   // Playwright cleans this dir only
  fullyParallel: true,
  workers: process.env.CI ? 4 : undefined,   // cap CI workers 
  retries: process.env.CI ? 2 : 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter,
  use: { trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
