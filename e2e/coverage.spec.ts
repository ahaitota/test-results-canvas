// End-to-end coverage of the Coverage tab: the report has to reach the browser,
// the sections have to say something actionable, and expanding a file has to
// show the real source with the right gutter colours.
//
// git is stubbed rather than real: these specs run inside this repository, so a
// live `git diff` would make the "New code" section depend on whatever the
// working tree happens to contain that minute.
import type { Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(E2E_DIR, "..");

const results = () => get_fixture_path("mixed.trx");
const cobertura = () => get_fixture_path("coverage/cobertura.xml");
const lcov = () => get_fixture_path("coverage/lcov.info");
const jacoco = () => get_fixture_path("coverage/jacoco.xml");

// The one file the reports and the fixture sources agree on.
const CALC = "coverage-sample/src/Calc.cs";

// Canned git, answering only the four commands changedLines() issues.
function stubGit(diff: string) {
  return (args: string[]): string | null => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${REPO_ROOT}\n`;
    if (args[0] === "ls-files") return "";
    if (args[0] === "diff") return diff;
    return null;
  };
}

// Coverage on, git off: the deterministic baseline for everything that is not
// about the change set.
const withCoverage = (coverageFile: string) => ({
  resultsFile: results(),
  coverageFile,
  coverage: true,
  gitExec: null,
});

test.describe("the coverage tab", () => {
  test("a loaded report shows a percentage on the tab and in the summary", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(cobertura()));
    await openCanvas(page, s);

    // 4 of 8 executable lines across the two fixture files.
    await expect(page.getByTestId("tab-coverage")).toContainText("50%");
    await expect(page.getByTestId("chip-coverage")).toContainText("50% covered");
  });

  test("the tests view is still what the panel opens on", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(cobertura()));
    await openCanvas(page, s);

    // Coverage is additive; it must not displace the view people came for.
    await expect(page.getByTestId("toolbar")).toBeVisible();
    await expect(page.getByTestId("coverage-view")).toHaveCount(0);
  });

  test("the summary chip switches to the coverage view", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(cobertura()));
    await openCanvas(page, s);

    await page.getByTestId("chip-coverage").click();
    await expect(page.getByTestId("coverage-view")).toBeVisible();
    await expect(page.getByTestId("coverage-headline")).toContainText("50%");
    await expect(page.getByTestId("coverage-meta")).toContainText("cobertura");
  });

  test("files are listed worst first, with their own numbers", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(cobertura()));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    const files = page.getByTestId("coverage-files").getByTestId("coverage-file");
    await expect(files).toHaveCount(2);
    // The file needing attention leads; sorting alphabetically would bury it.
    await expect(files.first()).toHaveAttribute("data-path", "coverage-sample/src/Dead.cs");
    await expect(files.first()).toContainText("0/3");
  });

  test("filtering narrows the file list", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(cobertura()));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    await page.getByTestId("coverage-search").fill("dead");
    await expect(page.getByTestId("coverage-files").getByTestId("coverage-file")).toHaveCount(1);
    await expect(page.getByTestId("coverage-showing")).toContainText("Showing 1 of 2");
  });

  test("expanding a file shows its source with covered and uncovered gutters", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(cobertura()));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    await page.getByTestId("coverage-files").locator(`[data-path="${CALC}"]`).click();

    const view = page.getByTestId("source-view").first();
    await expect(view).toBeVisible();
    // Read from disk, not reconstructed from the report.
    await expect(view).toContainText("public static int Add(int a, int b)");
    await expect(view.locator('[data-line="14"]')).toHaveAttribute("data-cov", "hit");
    await expect(view.locator('[data-line="26"]')).toHaveAttribute("data-cov", "miss");
    // A line the report never mentions is not executable, so it must not read
    // as a failure.
    await expect(view.locator('[data-line="1"]')).toHaveAttribute("data-cov", "neutral");
    // Expansion is keyed by path, so the same file opened from either section
    // shows the same view; scope the assertion to the one under test.
    await expect(view.getByTestId("source-ask")).toBeVisible();
  });

  test("uncovered blocks worth testing are ranked and shown", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(cobertura()));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    const hotspots = page.getByTestId("coverage-hotspot");
    // A whole untested module outranks a one-line gap.
    await expect(hotspots.first()).toContainText("Dead.cs");
    await expect(hotspots.first()).toContainText("never run");
  });
});

test.describe("new code", () => {
  test("changed lines that no test reached are called out", async ({ page, makeServer }) => {
    // Lines 24-29 changed: 24 and 29 are covered, 26 is not, and the braces and
    // the blank line are not executable at all.
    const diff = `--- a/${CALC}\n+++ b/${CALC}\n@@ -23,0 +24,6 @@\n+a\n+b\n+c\n+d\n+e\n+f\n`;
    const s = await makeServer({ resultsFile: results(), coverageFile: cobertura(), coverage: true, gitExec: stubGit(diff) });
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    await expect(page.getByTestId("patch-headline")).toContainText("1 of 3 changed lines not covered");
    await expect(page.getByTestId("patch-uncovered-lines")).toContainText("26");
    await expect(page.getByTestId("patch-ask")).toBeVisible();
  });

  test("a fully covered change set says so instead of nagging", async ({ page, makeServer }) => {
    const diff = `--- a/${CALC}\n+++ b/${CALC}\n@@ -13,0 +14 @@\n+a\n`;
    const s = await makeServer({ resultsFile: results(), coverageFile: cobertura(), coverage: true, gitExec: stubGit(diff) });
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    await expect(page.getByTestId("patch-headline")).toContainText("All 1 changed line");
    await expect(page.getByTestId("patch-ask")).toHaveCount(0);
  });

  test("with no diff the section explains itself rather than showing nothing", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(cobertura()));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    await expect(page.getByTestId("coverage-patch")).toContainText("No changed source files");
  });
});

test.describe("other report formats", () => {
  test("an LCOV report loads and resolves the same sources", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(lcov()));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    await expect(page.getByTestId("coverage-meta")).toContainText("lcov");
    await expect(page.getByTestId("coverage-headline")).toContainText("50%");
  });

  test("a JaCoCo report reassembles package-qualified paths", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(jacoco()));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    await expect(page.getByTestId("coverage-meta")).toContainText("jacoco");
    await expect(page.getByTestId("coverage-files").locator(`[data-path="${CALC}"]`)).toBeVisible();
  });
});

test.describe("no coverage", () => {
  // A results file on its own, in a throwaway repository so nothing in this
  // checkout can be discovered as its coverage report.
  let dir: string;
  let lonelyResults: string;

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "canvas-nocov-"));
    // Stops the project-root walk here, which in turn bounds the search.
    mkdirSync(join(dir, ".git"), { recursive: true });
    mkdirSync(join(dir, "run"), { recursive: true });
    lonelyResults = join(dir, "run", "mixed.trx");
    copyFileSync(get_fixture_path("mixed.trx"), lonelyResults);
  });

  test.afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("the empty state names the command that would produce a report", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: lonelyResults, coverage: true, gitExec: null });
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    // The state most users hit first, so it has to teach rather than be blank.
    await expect(page.getByTestId("coverage-empty")).toBeVisible();
    await expect(page.getByTestId("coverage-command")).toContainText("XPlat Code Coverage");
    await expect(page.getByTestId("coverage-ask-enable")).toBeVisible();
  });

  test("the tab carries no percentage when there is nothing to report", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: lonelyResults, coverage: true, gitExec: null });
    await openCanvas(page, s);

    await expect(page.getByTestId("chip-coverage")).toHaveCount(0);
    await expect(page.getByTestId("tab-coverage")).toHaveText("Coverage");
  });
});

test.describe("the source route", () => {
  // Same-origin fetch from the page, which is the only caller the route accepts.
  const getSource = (page: Page, file: string) =>
    page.evaluate(async (f) => {
      const r = await fetch("/source?file=" + encodeURIComponent(f));
      return r.status;
    }, file);

  test("serves only files the loaded report names", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(cobertura()));
    await openCanvas(page, s);

    expect(await getSource(page, CALC)).toBe(200);

    // The allow-list is the whole defence, so traversal has to fail as "not in
    // the report" rather than as a filtered path.
    for (const hostile of [
      "../../../../etc/passwd",
      "/etc/passwd",
      "package.json",
      "coverage-sample/src/../../package.json",
    ]) {
      expect(await getSource(page, hostile), `must refuse ${hostile}`).toBe(404);
    }
  });

  test("refuses everything when no coverage is loaded", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: results(), coverage: false });
    await openCanvas(page, s);

    expect(await getSource(page, CALC)).toBe(404);
  });
});
