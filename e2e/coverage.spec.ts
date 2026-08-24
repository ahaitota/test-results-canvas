// End-to-end coverage of the Coverage tab: the report has to reach the browser,
// the sections have to say something actionable, and expanding a file has to
// show the real source with the right gutter colours.
//
// git is stubbed rather than real: these specs run inside this repository, so a
// live `git diff` would make the "New code" section depend on whatever the
// working tree happens to contain that minute.
import type { Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, copyFileSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";
import type { AskRequest, ResultsServerOptions } from "../dist/src/server.js";

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

  // A report that measures the test project too -- normal for coverlet and
  // JaCoCo, which see test assemblies as just more code. Test code is fully
  // covered by definition (running it is what coverage measures), so counting
  // it flatters the total: 14/15 lines here, 93%, against 4/5 = 80% of the code
  // that actually ships. The headline has always reported the production
  // figure; the fraction beside it reported the whole report, so one line of UI
  // stated two different measurements.
  test("the headline fraction counts the same lines as the headline percentage", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(get_fixture_path("coverage/lcov-with-tests.info")));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    await expect(page.getByTestId("coverage-headline")).toContainText("80%");
    const meta = page.getByTestId("coverage-meta");
    await expect(meta).toContainText("4/5 lines");
    await expect(meta).toContainText("1 file");
    await expect(meta).not.toContainText("14/15");

    // The test file is still listed, it just is not part of the headline.
    await expect(page.getByTestId("coverage-files")).toContainText("CalcTests.cs");
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
    await expect(view.getByTestId("source-ask")).toBeVisible();
  });

  test("re-reading the report refreshes the gutters of a file already open", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(cobertura()));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();
    await page.getByTestId("coverage-files").locator(`[data-path="${CALC}"]`).click();

    const view = page.getByTestId("source-view").first();
    await expect(view.locator('[data-line="26"]')).toHaveAttribute("data-cov", "miss");

    const dir = mkdtempSync(join(tmpdir(), "cov-rerun-"));
    try {
      const next = join(dir, "coverage.cobertura.xml");
      writeFileSync(next, readFileSync(cobertura(), "utf8").replace('number="26" hits="0"', 'number="26" hits="7"'));
      s.loadCoverage(next);
      await expect(view.locator('[data-line="26"]')).toHaveAttribute("data-cov", "hit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ranked untested blocks are named on the file's own row", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(cobertura()));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    // A whole untested module outranks a one-line gap, so it leads the list and
    // says where its gap is -- what the separate "Worth covering" list used to
    // say in a second place, about a file the reader had to match up by name.
    const files = page.getByTestId("coverage-file");
    await expect(files.first()).toHaveAttribute("data-path", "coverage-sample/src/Dead.cs");
    await expect(files.first()).toContainText("biggest gap lines");
  });

  // The three lists overlapped rather than partitioned, so a changed file with
  // an untested block was drawn three times, a third of its story in each.
  test("a file appears once, however many of its facts are worth reporting", async ({ page, makeServer }) => {
    const diff = `--- a/${CALC}\n+++ b/${CALC}\n@@ -23,0 +24,6 @@\n+a\n+b\n+c\n+d\n+e\n+f\n`;
    const s = await makeServer({ resultsFile: results(), coverageFile: cobertura(), coverage: true, gitExec: stubGit(diff) });
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    // Changed, partly covered and holding a ranked gap: previously three rows.
    await expect(page.locator(`[data-path="${CALC}"]`)).toHaveCount(1);

    const row = page.locator(`[data-path="${CALC}"]`);
    await expect(row).toContainText("changed");
    await expect(row).toContainText("changed lines untested");

    // And one row means one thing opens.
    await expect(page.getByTestId("source-view")).toHaveCount(0);
    await row.getByRole("button").first().click();
    await expect(page.getByTestId("source-view")).toHaveCount(1);
    await row.getByRole("button").first().click();
    await expect(page.getByTestId("source-view")).toHaveCount(0);
  });

  test("a file with several gaps reports all of them on its one row", async ({ page, makeServer }) => {
    // Gaps.cs is uncovered at 13-15 and again at 22-24: two ranked regions that
    // used to be two rows.
    const s = await makeServer(withCoverage(get_fixture_path("coverage/cobertura-two-gaps.xml")));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    const rows = page.getByTestId("coverage-file").filter({ hasText: "Gaps.cs" });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("+1 more block");
  });

  test("the list can be reordered for browsing without losing any of the detail", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(cobertura()));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    const files = page.getByTestId("coverage-file");
    await expect(files.first()).toHaveAttribute("data-path", "coverage-sample/src/Dead.cs");

    await page.getByTestId("coverage-sort").selectOption("name");
    await expect(files.first()).toHaveAttribute("data-path", CALC);
    // Sorting is not filtering: every file is still present, still annotated.
    await expect(files).toHaveCount(2);
    await expect(files.first()).toContainText("%");
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
    await expect(page.getByTestId("coverage-row-note").first()).toContainText("26");
    await expect(page.getByTestId("patch-ask")).toBeVisible();
    // Three of the six changed lines are absent from the report, so the
    // percentage describes the other three and has to say which it is.
    await expect(page.getByTestId("patch-pct-note")).toHaveText("of measured");
  });

  test("a fully covered change set says so instead of nagging", async ({ page, makeServer }) => {
    const diff = `--- a/${CALC}\n+++ b/${CALC}\n@@ -13,0 +14 @@\n+a\n`;
    const s = await makeServer({ resultsFile: results(), coverageFile: cobertura(), coverage: true, gitExec: stubGit(diff) });
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    await expect(page.getByTestId("patch-headline")).toContainText("All 1 changed line");
    await expect(page.getByTestId("patch-ask")).toHaveCount(0);
    // The report measured the whole change here, so the percentage stands
    // unqualified.
    await expect(page.getByTestId("patch-pct-note")).toHaveCount(0);
  });

  // A new file that no test imports produces no uncovered lines *because*
  // nothing observed it. Reporting only the measured subset would read as if it
  // were the whole change set, so the count of blind spots is always named.
  test("changed files the report never measured are named in the headline", async ({ page, makeServer }) => {
    const ghost = "coverage-sample/src/Ghost.cs";
    const diff = `--- a/${CALC}\n+++ b/${CALC}\n@@ -13,0 +14 @@\n+a\n`
      + `--- a/${ghost}\n+++ b/${ghost}\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n`;
    const s = await makeServer({ resultsFile: results(), coverageFile: cobertura(), coverage: true, gitExec: stubGit(diff) });
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    // Every measured line ran, but the headline must not call that a clean sweep.
    await expect(page.getByTestId("patch-headline")).toContainText("1 changed file with no coverage data");
    const ghostRow = page.getByTestId("coverage-file").filter({ hasText: "Ghost.cs" });
    await expect(ghostRow).toBeVisible();
    // "No data" and "0%" look alike and mean opposite things, so the row says
    // which one this is rather than showing an empty bar.
    await expect(ghostRow).toContainText("not measured");
    await expect(ghostRow).toContainText("no data");
    // And it carries a size, so one blind spot can be told from another.
    await expect(ghostRow).toContainText("3 changed lines, none of them measured");
    // "Why is this not measured?" is the first question the row provokes, and
    // the reasons are never visible in the report itself, so the tag carries
    // them rather than leaving the reader to guess or to ask.
    const why = await ghostRow.getByText("not measured").getAttribute("title");
    expect(why).toContain("never loaded this file");
    expect(why).toContain("not the same as 0%");
    await expect(page.getByTestId("patch-ask")).toBeVisible();
  });

  test("with no diff the section explains itself rather than showing nothing", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(cobertura()));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    await expect(page.getByTestId("coverage-patch")).toContainText("No changed source files");
  });
});

// The three coverage buttons are the tab's only way back into the conversation.
// Each names a scope and nothing more: the prompt is the server's own words, so
// what these assert is that the right scope arrives and that the button tells
// the truth about whether it got there.
test.describe("asking the agent about coverage", () => {
  // Lines 24-29 changed with 26 uncovered, so the New code section has something
  // to complain about and offers its button.
  const UNCOVERED_DIFF = `--- a/${CALC}\n+++ b/${CALC}\n@@ -23,0 +24,6 @@\n+a\n+b\n+c\n+d\n+e\n+f\n`;

  const withPatch = (onAsk: ResultsServerOptions["onAsk"]) => ({
    resultsFile: results(),
    coverageFile: cobertura(),
    coverage: true,
    gitExec: stubGit(UNCOVERED_DIFF),
    onAsk,
  });

  test("the new-code button asks about the change set", async ({ page, makeServer }) => {
    const asks: AskRequest[] = [];
    const s = await makeServer(withPatch((req) => {
      asks.push(req);
    }));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    const button = page.getByTestId("patch-ask");
    await button.click();

    await expect(button).toHaveText("Asked the agent");
    expect(asks).toHaveLength(1);
    expect(asks[0].coverage?.scope).toBe("patch");
    // A patch ask carries no path -- the scope alone says what to look at.
    expect(asks[0].coverage?.path).toBeUndefined();
    // The page sent a scope; the prompt is composed from the server's report.
    expect(asks[0].prompt).toContain(CALC);
  });

  test("a file's button asks about that file, naming it to the server", async ({ page, makeServer }) => {
    const asks: AskRequest[] = [];
    const s = await makeServer(withPatch((req) => {
      asks.push(req);
    }));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();
    await page.getByTestId("coverage-files").locator(`[data-path="${CALC}"]`).click();

    const button = page.getByTestId("source-view").first().getByTestId("source-ask");
    await button.click();

    await expect(button).toHaveText("Asked the agent");
    expect(asks).toHaveLength(1);
    expect(asks[0].coverage?.scope).toBe("file");
    expect(asks[0].coverage?.path).toBe(CALC);
    // 26 is the uncovered line in the fixture, and the server looked it up
    // rather than taking it from the page.
    expect(asks[0].prompt).toContain("26");
  });

  test("a host that cannot deliver leaves the button saying so", async ({ page, makeServer }) => {
    const s = await makeServer(withPatch(() => {
      throw new Error("session gone");
    }));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    const button = page.getByTestId("patch-ask");
    await button.click();

    // The POST arrived and was refused, so the button must not claim success.
    await expect(button).toHaveText("Could not reach the agent");
  });

  // The request never lands at all -- a closing panel or a dropped connection.
  // fetch() rejects rather than returning a response, which is a different path
  // through the client than a refusal, and just as invisible if it throws.
  test("a request that never arrives is reported, not thrown", async ({ page, makeServer }) => {
    const asks: AskRequest[] = [];
    const s = await makeServer(withPatch((req) => {
      asks.push(req);
    }));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();
    await page.route((url) => url.pathname === "/ask-coverage", (route) => route.abort());

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    const button = page.getByTestId("patch-ask");
    await button.click();

    await expect(button).toHaveText("Could not reach the agent");
    expect(asks).toHaveLength(0);
    expect(errors).toEqual([]);
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

  // Node's --experimental-test-coverage emits a DA entry for nearly every line,
  // comments included, so a report can claim prose is untested code. This
  // fixture says lines 1, 2, 5, 9 (comments) and 16 (blank) are coverable and
  // were never hit. Taken at face value that is 4 of 10 lines, or 40%; the five
  // that could actually run are 4 of 5.
  test("comment and blank lines the report claims are coverable are discarded", async ({ page, makeServer }) => {
    const s = await makeServer(withCoverage(get_fixture_path("coverage/lcov-noisy.info")));
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    await expect(page.getByTestId("tab-coverage")).toContainText("80%");
    await expect(page.getByTestId("tab-coverage")).not.toContainText("40%");

    await page.getByTestId("coverage-files").locator(`[data-path="${CALC}"]`).click();
    const view = page.getByTestId("source-view").first();
    await expect(view).toBeVisible();
    // A comment must not read as a failure just because the tool listed it.
    await expect(view.locator('[data-line="1"]')).toHaveAttribute("data-cov", "neutral");
    await expect(view.locator('[data-line="16"]')).toHaveAttribute("data-cov", "neutral");
    // Real code is untouched by the filtering.
    await expect(view.locator('[data-line="14"]')).toHaveAttribute("data-cov", "hit");
    await expect(view.locator('[data-line="26"]')).toHaveAttribute("data-cov", "miss");
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

  // The one ask available before any report exists, so its scope cannot be a
  // file or a change set -- there is nothing measured to name.
  test("the empty state's button asks for coverage to be turned on", async ({ page, makeServer }) => {
    const asks: AskRequest[] = [];
    const s = await makeServer({
      resultsFile: lonelyResults,
      coverage: true,
      gitExec: null,
      onAsk: (req) => { asks.push(req); },
    });
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    const button = page.getByTestId("coverage-ask-enable");
    await button.click();

    await expect(button).toHaveText("Asked the agent");
    expect(asks).toHaveLength(1);
    expect(asks[0].coverage?.scope).toBe("enable");
    // The prompt is the command the empty state was already showing.
    expect(asks[0].prompt).toContain("XPlat Code Coverage");
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
