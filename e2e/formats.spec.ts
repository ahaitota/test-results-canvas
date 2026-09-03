import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";
import { copyFileSync, mkdirSync, appendFileSync } from "node:fs";
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
});
