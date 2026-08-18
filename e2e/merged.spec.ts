import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Several results files merged into one run: a .NET solution writes one TRX per
// test project, and the panel has to show them together without hiding which
// project a row came from.

const billing = () => get_fixture_path("merge-billing.trx");
const shipping = () => get_fixture_path("merge-shipping.trx");
const empty = () => get_fixture_path("empty.trx");

test.describe("merged runs", () => {
  test("shows every test from every file", async ({ page, makeServer }) => {
    const s = await makeServer({ name: "Solution", resultsFiles: [billing(), shipping()] });
    await openCanvas(page, s);
    // 2 from billing + 3 from shipping.
    await expect(page.getByTestId("test-row")).toHaveCount(5);
    await expect(page.getByTestId("test-name").filter({ hasText: "RejectsNegativeAmount" })).toBeVisible();
    await expect(page.getByTestId("test-name").filter({ hasText: "CalculatesPostage" })).toBeVisible();
  });

  test("heads the run with its name and a per-file breakdown", async ({ page, makeServer }) => {
    const s = await makeServer({ name: "Solution", resultsFiles: [billing(), shipping()] });
    await openCanvas(page, s);

    await expect(page.getByTestId("group-name")).toHaveText("Solution");
    await expect(page.getByTestId("group-counts")).toHaveText("2 files \u00B7 5 tests");

    const sources = page.getByTestId("group-source");
    await expect(sources).toHaveCount(2);
    await expect(sources.nth(0)).toContainText("merge-billing.trx");
    await expect(sources.nth(0)).toContainText("2");
    await expect(sources.nth(1)).toContainText("merge-shipping.trx");
    await expect(sources.nth(1)).toContainText("3");
  });

  test("counts a file that reported nothing without dropping it", async ({ page, makeServer }) => {
    const s = await makeServer({ name: "Solution", resultsFiles: [billing(), empty()] });
    await openCanvas(page, s);

    await expect(page.getByTestId("test-row")).toHaveCount(2);
    await expect(page.getByTestId("group-counts")).toHaveText("2 files \u00B7 2 tests");
    const sources = page.getByTestId("group-source");
    await expect(sources.nth(1)).toContainText("empty.trx");
    await expect(sources.nth(1)).toContainText("0");
  });

  test("splits a merged run back apart by file", async ({ page, makeServer }) => {
    const s = await makeServer({ name: "Solution", resultsFiles: [billing(), shipping()] });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("file");

    await expect(page.getByTestId("group")).toHaveCount(2);
    await expect(page.getByTestId("group-header").filter({ hasText: "merge-billing.trx" })).toBeVisible();
    await expect(page.getByTestId("group-header").filter({ hasText: "merge-shipping.trx" })).toBeVisible();
  });

  test("keeps the same test name from two projects as two rows", async ({ page, makeServer }) => {
    const s = await makeServer({ name: "Solution", resultsFiles: [billing(), shipping()] });
    await openCanvas(page, s);
    // ChargesCard exists in both files; folding them would hide one project's result.
    await expect(page.getByTestId("test-name").filter({ hasText: "ChargesCard" })).toHaveCount(2);
  });

  test("finds rows by the file they came from", async ({ page, makeServer }) => {
    const s = await makeServer({ name: "Solution", resultsFiles: [billing(), shipping()] });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("none");

    await page.getByTestId("search").fill("merge-shipping");
    await expect(page.getByTestId("test-row")).toHaveCount(3);
  });

  test("names the originating file in a row's details", async ({ page, makeServer }) => {
    const s = await makeServer({ name: "Solution", resultsFiles: [billing(), shipping()] });
    await openCanvas(page, s);

    const row = page.getByTestId("test-row").filter({ hasText: "CalculatesPostage" });
    await row.getByTestId("row-header").click();
    await row.getByTestId("show-more").click();
    await expect(row.getByTestId("row-secondary")).toContainText("merge-shipping.trx");
  });

  test("lists the run and its files together in the picker", async ({ page, makeServer }) => {
    const s = await makeServer({ name: "Solution", resultsFiles: [billing(), shipping()] });
    await openCanvas(page, s);

    const options = page.getByTestId("file-select").locator("option");
    await expect(options.filter({ hasText: "Solution" })).toHaveCount(1);
    await expect(options.filter({ hasText: "merge-billing.trx" })).toHaveCount(1);

    // Drilling into one file leaves the merged run behind, so the header goes —
    // but the run itself must stay listed, or there is no way back to it.
    await page.getByTestId("file-select").selectOption("merge-billing.trx");
    await expect(page.getByTestId("test-row")).toHaveCount(2);
    await expect(page.getByTestId("group-summary")).toHaveCount(0);
    await expect(options.filter({ hasText: "Solution" })).toHaveCount(1);
  });

  test("a single file is not presented as a merged run", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-row")).toHaveCount(6);
    await expect(page.getByTestId("group-summary")).toHaveCount(0);

    // The picker already names the one file, so a row must not repeat it.
    const row = page.getByTestId("test-row").first();
    await row.getByTestId("row-header").click();
    await row.getByTestId("show-more").click();
    await expect(row.getByTestId("row-secondary")).not.toContainText("mixed.trx");

    // Grouping by File would bucket every test under one meaningless heading.
    await expect(page.getByTestId("group-by").locator("option[value='file']")).toHaveCount(0);
  });

  // The action path, which reaches the panel after it is already open. A
  // one-element list is the reviewer's case: it must land as an ordinary run,
  // not a group of one with nothing to group by.
  for (const named of [false, true]) {
    const groupName = named ? "Billing only" : "Merged results";
    test(`open_files with one file is an ordinary run${named ? ", even when named" : ""}`, async ({ page, makeServer }) => {
      const s = await makeServer();
      await openCanvas(page, s);
      const r = s.openFiles(named ? { name: groupName, files: [billing()] } : { files: [billing()] });

      // The receipt still reports the one source it merged.
      expect(r.ok).toBe(true);
      expect(r.sources).toEqual([{ label: "merge-billing.trx", count: 2 }]);

      // Payload: no group, and rows carry no originating file to show.
      await expect(page.getByTestId("test-row")).toHaveCount(2);
      expect(s.getResults().some((t) => "source" in t)).toBe(false);

      await expect(page.getByTestId("group-summary")).toHaveCount(0);
      await expect(page.getByTestId("group-by").locator("option[value='file']")).toHaveCount(0);
      // The name must not reach the picker either, or it offers a group to
      // return to that was never really there.
      const options = page.getByTestId("file-select").locator("option");
      await expect(options.filter({ hasText: groupName })).toHaveCount(0);
    });
  }

  test("a one-file open_files clears the group it replaced", async ({ page, makeServer }) => {
    const s = await makeServer({ name: "Solution", resultsFiles: [billing(), shipping()] });
    await openCanvas(page, s);
    await expect(page.getByTestId("group-summary")).toBeVisible();

    s.openFiles({ name: "Shipping only", files: [shipping()] });

    await expect(page.getByTestId("test-row")).toHaveCount(3);
    await expect(page.getByTestId("group-summary")).toHaveCount(0);
    // The superseded run must not linger as a way back to a merge that is gone.
    const options = page.getByTestId("file-select").locator("option");
    await expect(options.filter({ hasText: "Solution" })).toHaveCount(0);
    await expect(options.filter({ hasText: "Shipping only" })).toHaveCount(0);
  });

  test("drilling out of a merged run drops the File grouping with it", async ({ page, makeServer }) => {
    const s = await makeServer({ name: "Solution", resultsFiles: [billing(), shipping()] });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("file");
    await expect(page.getByTestId("group")).toHaveCount(2);

    await page.getByTestId("file-select").selectOption("merge-billing.trx");

    // The option is gone, so the select must not still claim to be on it, and
    // the rows must not collapse into an unnamed bucket.
    await expect(page.getByTestId("group-by")).not.toHaveValue("file");
    await expect(page.getByTestId("group-header").filter({ hasText: "(no file)" })).toHaveCount(0);
    await expect(page.getByTestId("test-row")).toHaveCount(2);
  });

  // Twice round, because a restore that only half-rebuilds tends to pass the
  // first lap and fail the second.
  test("picking the merged run again rebuilds it", async ({ page, makeServer }) => {
    const s = await makeServer({ name: "Solution", resultsFiles: [billing(), shipping()] });
    await openCanvas(page, s);
    const picker = page.getByTestId("file-select");

    for (const lap of [1, 2]) {
      await picker.selectOption("merge-shipping.trx");
      await expect(page.getByTestId("test-row"), `lap ${lap}`).toHaveCount(3);

      await picker.selectOption("Solution");
      await expect(page.getByTestId("test-row"), `lap ${lap}`).toHaveCount(5);
      await expect(page.getByTestId("group-summary")).toBeVisible();
      await expect(page.getByTestId("group-counts")).toHaveText("2 files \u00B7 5 tests");
      await expect(page.getByTestId("group-source")).toHaveCount(2);
      await expect(page.getByTestId("group-by").locator("option[value='file']")).toHaveCount(1);
    }

    // The restored run is a real merge, not just a restored header.
    await page.getByTestId("group-by").selectOption("file");
    await expect(page.getByTestId("group")).toHaveCount(2);
  });

  // Copies rather than the fixtures themselves: this is the one spec that
  // rewrites a source, and the watcher is only enabled here.
  test("a rewritten file refreshes without disturbing the others", async ({ page, makeServer }, testInfo) => {
    const dir = testInfo.outputPath("sources");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.trx");
    const b = join(dir, "b.trx");
    copyFileSync(billing(), a);
    copyFileSync(shipping(), b);

    const s = await makeServer({ name: "Solution", resultsFiles: [a, b], watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-row")).toHaveCount(5);

    // Shrink b; a must be untouched and only b's count may move.
    copyFileSync(get_fixture_path("empty.trx"), b);

    await expect(page.getByTestId("group-counts")).toHaveText("2 files \u00B7 2 tests");
    await expect(page.getByTestId("test-name").filter({ hasText: "RejectsNegativeAmount" })).toBeVisible();
    await expect(page.getByTestId("test-name").filter({ hasText: "CalculatesPostage" })).toHaveCount(0);
  });
});
