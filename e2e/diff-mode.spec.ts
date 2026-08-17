// End-to-end coverage of diff mode: the strip has to appear only when there is
// a change to talk about, the badges have to land on the right rows, and
// "Relevant only" has to narrow the list without fighting the other filters.
//
// git is stubbed, as in coverage.spec.ts: these specs run inside this
// repository, so a live `git diff` would let whatever the working tree happens
// to hold that minute decide what gets tagged.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every row in mixed.trx belongs to class "Mock.Tests".
const results = () => get_fixture_path("mixed.trx");

// Canned git, answering only the commands changedLines() issues. `untracked`
// is what `ls-files --others` reports: files git has never seen.
function stubGit(diff: string, untracked = "") {
  return (args: string[]): string | null => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${REPO_ROOT}\n`;
    if (args[0] === "ls-files") return untracked;
    if (args[0] === "diff") return diff;
    return null;
  };
}

// One changed hunk in `path`, in the form `git diff --unified=0` emits.
function hunk(path: string): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,0 +2,1 @@", "+changed"].join("\n");
}

// A changed production file: Mock.cs is what a class called Mock.Tests tests.
const PRODUCTION_DIFF = hunk("src/Mock.cs");
// The test file itself.
const TEST_DIFF = hunk("test/Mock.Tests.cs");

test.describe("diff mode", () => {
  test("stays out of the way when git has nothing to report", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: results(), gitExec: stubGit("") });
    await openCanvas(page, s);

    await expect(page.getByTestId("test-row")).toHaveCount(6);
    await expect(page.getByTestId("diffbar")).toHaveCount(0);
  });

  test("is absent entirely outside a git repository", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: results(), gitExec: null });
    await openCanvas(page, s);

    await expect(page.getByTestId("test-row")).toHaveCount(6);
    await expect(page.getByTestId("diffbar")).toHaveCount(0);
  });

  test("a changed production file marks its tests as maybe impacted", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: results(), gitExec: stubGit(PRODUCTION_DIFF) });
    await openCanvas(page, s);

    await expect(page.getByTestId("diffbar")).toBeVisible();
    await expect(page.getByTestId("diff-scope")).toContainText("1 file");
    await expect(page.getByTestId("count-impacted")).toContainText("6 tests may be impacted");
    // Badges belong to the narrowed view, so they are absent until it is on.
    await expect(page.getByTestId("relevance")).toHaveCount(0);

    await page.getByTestId("relevant-only").check();
    await expect(page.getByTestId("relevance").first()).toHaveAttribute("data-relevance", "impacted");
    // The evidence, not just the verdict.
    await expect(page.getByTestId("relevance").first()).toHaveAttribute("title", /src\/Mock\.cs changed/);
  });

  test("a changed test file marks its own tests as modified", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: results(), gitExec: stubGit(TEST_DIFF) });
    await openCanvas(page, s);

    await expect(page.getByTestId("count-modified")).toContainText("6 tests you edited");
    await page.getByTestId("relevant-only").check();
    await expect(page.getByTestId("relevance").first()).toHaveAttribute("data-relevance", "modified");
  });

  test("a test file git has never seen makes its tests new", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: results(), gitExec: stubGit("", "test/Mock.Tests.cs\n") });
    await openCanvas(page, s);

    await expect(page.getByTestId("count-new")).toContainText("6 new tests added");
    await page.getByTestId("relevant-only").check();
    await expect(page.getByTestId("relevance").first()).toHaveAttribute("data-relevance", "new");
  });

  test("build output is not counted as a change worth testing", async ({ page, makeServer }) => {
    // A repo that commits its dist/ would otherwise bury the one real edit.
    const s = await makeServer({
      resultsFile: results(),
      gitExec: stubGit([hunk("dist/src/Mock.js"), hunk("dist/client/app.js"), PRODUCTION_DIFF].join("\n")),
    });
    await openCanvas(page, s);

    await expect(page.getByTestId("diff-scope")).toContainText("1 file");
  });

  test("says so plainly when the change touches nothing the run covers", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: results(), gitExec: stubGit(hunk("src/Unrelated.cs")) });
    await openCanvas(page, s);

    await expect(page.getByTestId("diff-none")).toBeVisible();
    await expect(page.getByTestId("relevance")).toHaveCount(0);
    // Nothing to narrow to, so the switch is not offered.
    await expect(page.getByTestId("relevant-only")).toBeDisabled();
  });

  test("'Relevant only' narrows the list and lets go again", async ({ page, makeServer }) => {
    // A JUnit run where only one case names the changed file.
    const s = await makeServer({
      resultsFile: get_fixture_path("diff-mode.junit.xml"),
      gitExec: stubGit(hunk("src/calc.ts")),
    });
    await openCanvas(page, s);

    await expect(page.getByTestId("test-row")).toHaveCount(3);
    await expect(page.getByTestId("count-impacted")).toContainText("1 test may be impacted");

    await page.getByTestId("relevant-only").check();
    await expect(page.getByTestId("test-row")).toHaveCount(1);
    await expect(page.getByTestId("test-name")).toHaveText("adds");

    await page.getByTestId("relevant-only").uncheck();
    await expect(page.getByTestId("test-row")).toHaveCount(3);
  });

  test("'Relevant only' composes with the search box", async ({ page, makeServer }) => {
    const s = await makeServer({
      resultsFile: get_fixture_path("diff-mode.junit.xml"),
      gitExec: stubGit(hunk("src/calc.ts")),
    });
    await openCanvas(page, s);

    await page.getByTestId("relevant-only").check();
    await page.getByTestId("search").fill("nothing-matches-this");
    await expect(page.getByTestId("test-row")).toHaveCount(0);

    await page.getByTestId("search").fill("adds");
    await expect(page.getByTestId("test-row")).toHaveCount(1);
  });

  test("asking the agent which tests are affected reaches the host once", async ({ page, makeServer }) => {
    const asks: string[] = [];
    const s = await makeServer({
      resultsFile: results(),
      gitExec: stubGit(PRODUCTION_DIFF),
      onAsk: (req) => {
        asks.push(req.prompt);
      },
    });
    await openCanvas(page, s);

    await page.getByTestId("ask-impact").click();
    await expect(page.getByTestId("ask-impact")).toHaveAttribute("data-ask-state", "sent");
    expect(asks).toHaveLength(1);
    // The prompt has to carry the change and name the action that answers it.
    expect(asks[0]).toContain("src/Mock.cs");
    expect(asks[0]).toContain("set_impacted_tests");
  });
});
