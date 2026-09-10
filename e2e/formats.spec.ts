import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The non-XML formats end to end: the server has to detect them from content
// and keep watching them for re-runs, exactly as it does for TRX/JUnit.
//
// The watcher and merge-state scenarios these formats surfaced -- folders
// deleted and recreated, re-runs that rename every file, reports caught
// mid-write -- are all reachable with plain TRX on main and are covered by the
// follow-up in #43, not here.

test.describe("cross-language report formats", () => {
  test("renders a TAP 13 report", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("calc.tap") });
    await openCanvas(page, s);

    await expect(page.getByTestId("test-row")).toHaveCount(3);
    await expect(page.getByTestId("test-name").filter({ hasText: "subtracts two numbers" })).toBeVisible();
    await expect(page.getByTestId("chip-fail")).toHaveText("1 failed");
    await expect(page.getByTestId("chip-skip")).toHaveText("1 skipped");
  });

  test("renders a go test JSON stream and follows the next run", async ({ page, makeServer }, testInfo) => {
    const dir = testInfo.outputPath("go");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "go-test.jsonl");
    copyFileSync(get_fixture_path("gotest.jsonl"), file);

    const s = await makeServer({ resultsFile: file, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-row")).toHaveCount(2);

    // A re-run writes the stream afresh: `go test` closes a package with its
    // own outcome, so nothing follows that within one run.
    const rerun = [
      { Time: "2024-01-01T10:05:00Z", Action: "run", Package: "example/calc", Test: "TestAddsTwoNumbers" },
      { Time: "2024-01-01T10:05:01Z", Action: "pass", Package: "example/calc", Test: "TestAddsTwoNumbers", Elapsed: 0.04 },
      { Time: "2024-01-01T10:05:01Z", Action: "skip", Package: "example/calc", Test: "TestDivides", Elapsed: 0 },
      { Time: "2024-01-01T10:05:01Z", Action: "pass", Package: "example/calc", Elapsed: 0.1 },
    ].map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(file, `${rerun}\n`, "utf8");

    await expect(page.getByTestId("test-row")).toHaveCount(2);
    await expect(page.getByTestId("test-name").filter({ hasText: "TestDivides" })).toBeVisible();
  });

  test("opens an Allure folder named by several of its own result files", async ({ page, makeServer }, testInfo) => {
    // Those paths are one run, so the second is redundant rather than a second
    // source: reading it too would merge every row twice.
    const dir = testInfo.outputPath("allure-duplicates");
    mkdirSync(dir, { recursive: true });
    const first = join(dir, "aaa-result.json");
    const second = join(dir, "bbb-result.json");
    writeFileSync(first, `{"uuid":"aaa","name":"adds","status":"passed"}`, "utf8");
    writeFileSync(second, `{"uuid":"bbb","name":"subtracts","status":"failed"}`, "utf8");

    const s = await makeServer({ name: "Allure", resultsFiles: [first, second], watch: false });
    await openCanvas(page, s);

    await expect(page.getByTestId("test-row")).toHaveCount(2);
    await expect(page.getByTestId("test-name").filter({ hasText: "subtracts" })).toBeVisible();
  });

  test("opens an Allure folder whose results only identify themselves late", async ({ page, makeServer }, testInfo) => {
    // Same run, but nothing in the first 8 KiB of either file says so. Grouping
    // has to agree with parsing, or each file is taken for a source of its own
    // and the pair of them expands to every row twice over.
    const dir = testInfo.outputPath("allure-late");
    mkdirSync(dir, { recursive: true });
    const pad = "x".repeat(9000);
    const first = join(dir, "aaa-result.json");
    const second = join(dir, "bbb-result.json");
    writeFileSync(first, `{"description":"${pad}","uuid":"aaa","name":"adds","status":"passed"}`, "utf8");
    writeFileSync(second, `{"description":"${pad}","uuid":"bbb","name":"subtracts","status":"failed"}`, "utf8");

    const s = await makeServer({ name: "Allure", resultsFiles: [first, second], watch: false });
    await openCanvas(page, s);

    await expect(page.getByTestId("test-row")).toHaveCount(2);
  });
});
