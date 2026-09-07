import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";
import { copyFileSync, mkdirSync, appendFileSync, writeFileSync, rmSync } from "node:fs";
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

  test("re-anchors an Allure source when the run that named it is replaced", async ({ page, makeServer }, testInfo) => {
    // A re-run clears the folder and writes fresh files, so the file the source
    // was anchored on no longer exists.
    const dir = testInfo.outputPath("allure-replaced");
    mkdirSync(dir, { recursive: true });
    const first = join(dir, "aaa-result.json");
    const other = join(dir, "run.xml");
    writeFileSync(first, `{"uuid":"aaa","name":"adds","status":"passed"}`, "utf8");
    writeFileSync(other, `<testsuites><testsuite name="s"><testcase name="unrelated" /></testsuite></testsuites>`, "utf8");

    const s = await makeServer({ name: "Mixed", resultsFiles: [first, other], watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-name").filter({ hasText: "adds" })).toBeVisible();

    rmSync(first);
    writeFileSync(join(dir, "ccc-result.json"), `{"uuid":"ccc","name":"divides","status":"passed"}`, "utf8");

    await expect(page.getByTestId("test-name").filter({ hasText: "divides" })).toBeVisible();
    await expect(page.getByTestId("test-name").filter({ hasText: "adds" })).toHaveCount(0);
  });

  test("keeps watching a source whose extension no folder scan would look at", async ({ page, makeServer }, testInfo) => {
    // An explicitly named file is accepted by content, so it can be called
    // anything -- and its rewrites have to reach the panel all the same.
    const dir = testInfo.outputPath("custom-ext");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "junit.report");
    const suite = (cases: string) => `<testsuites><testsuite name="s">${cases}</testsuite></testsuites>`;
    writeFileSync(file, suite(`<testcase name="adds" />`), "utf8");

    const s = await makeServer({ resultsFile: file, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-row")).toHaveCount(1);

    writeFileSync(file, suite(`<testcase name="adds" /><testcase name="subtracts" />`), "utf8");

    await expect(page.getByTestId("test-row")).toHaveCount(2);
  });
});
