import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";
import { copyFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The non-XML formats end to end: the server has to detect them from content and
// keep watching them for re-runs, exactly as it does for TRX/JUnit.

test.describe("cross-language report formats", () => {
  test("renders a TAP 13 report", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("calc.tap") });
    await openCanvas(page, s);

    await expect(page.getByTestId("test-row")).toHaveCount(3);
    await expect(page.getByTestId("test-name").filter({ hasText: "subtracts two numbers" })).toBeVisible();
    await expect(page.getByTestId("chip-fail")).toHaveText("1 failed");
    await expect(page.getByTestId("chip-skip")).toHaveText("1 skipped");
  });

  test("renders a go test JSON stream and refreshes when it grows", async ({ page, makeServer }, testInfo) => {
    const dir = testInfo.outputPath("go");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "go-test.jsonl");
    copyFileSync(get_fixture_path("gotest.jsonl"), file);

    const s = await makeServer({ resultsFile: file, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-row")).toHaveCount(2);

    appendFileSync(file, `{"Action":"skip","Package":"example/calc","Test":"TestDivides","Elapsed":0}\n`, "utf8");

    await expect(page.getByTestId("test-row")).toHaveCount(3);
    await expect(page.getByTestId("test-name").filter({ hasText: "TestDivides" })).toBeVisible();
  });

  test("refreshes an Allure source when a new sibling result appears beside it", async ({ page, makeServer }, testInfo) => {
    // The Allure source shares its folder with another report, so it is not the
    // only entry there -- and a brand-new result file carries a name no entry is
    // stored under.
    const dir = testInfo.outputPath("allure");
    mkdirSync(dir, { recursive: true });
    const first = join(dir, "aaa-result.json");
    const other = join(dir, "run.xml");
    writeFileSync(first, `{"uuid":"aaa","name":"adds","status":"passed"}`, "utf8");
    writeFileSync(other, `<testsuites><testsuite name="s"><testcase name="unrelated" /></testsuite></testsuites>`, "utf8");

    const s = await makeServer({ name: "Mixed", resultsFiles: [first, other], watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-row")).toHaveCount(2);

    writeFileSync(join(dir, "bbb-result.json"), `{"uuid":"bbb","name":"subtracts","status":"failed"}`, "utf8");

    await expect(page.getByTestId("test-row")).toHaveCount(3);
    await expect(page.getByTestId("test-name").filter({ hasText: "subtracts" })).toBeVisible();
  });
});
