import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";
import type { Page } from "@playwright/test";

// The list renders only the slice of rows the viewport is over. These guard the
// things that go wrong when that is done badly: blank strips, a scrollbar that
// changes length, and rows that can no longer be reached.

const TOTAL = 3000;

function bigRun() {
  return Array.from({ length: TOTAL }, (_, i) => ({
    name: "test " + String(i).padStart(4, "0"),
    className: "Suite" + Math.floor(i / 100) + ".Case",
    suite: "Suite" + Math.floor(i / 100),
    // One failure, far past anything that could be rendered at first paint.
    status: i === 2900 ? "fail" : "pass",
    message: i === 2900 ? "the last thing to break" : undefined,
    durationMs: 5,
  }));
}

// No spacer may be visible: every sample point down the viewport has to land on
// real content.
async function expectNoBlankStrip(page: Page) {
  const spacerHits = await page.evaluate(() => {
    const list = document.querySelector("#list") as HTMLElement;
    const box = list.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const hits: number[] = [];
    for (let y = 4; y < window.innerHeight; y += 40) {
      if (y < box.top || y > box.bottom) continue;
      const el = document.elementFromPoint(x, y);
      if (el && el.closest(".vspace")) hits.push(y);
    }
    return hits;
  });
  expect(spacerHits).toEqual([]);
}

test.describe("virtualized list", () => {
  test("keeps the DOM small for a large run", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("empty.trx") });
    await openCanvas(page, s);
    await s.setResults(bigRun());

    await expect(page.getByTestId("test-row").first()).toBeVisible();
    // A fraction of the run, not all of it: the whole point of the window.
    expect(await page.getByTestId("test-row").count()).toBeLessThan(TOTAL / 10);
    await expectNoBlankStrip(page);
  });

  test("scrolling reaches the last row and never shows a gap", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("empty.trx") });
    await openCanvas(page, s);
    await s.setResults(bigRun());
    await expect(page.getByTestId("test-row").first()).toBeVisible();

    const heights: number[] = [];
    for (const fraction of [0.25, 0.5, 0.75]) {
      await page.evaluate((f) => window.scrollTo(0, document.body.scrollHeight * f), fraction);
      await page.waitForTimeout(120);
      await expectNoBlankStrip(page);
      heights.push(await page.evaluate(() => document.body.scrollHeight));
    }
    // The spacers stand in for real rows, so the page must not resize as those
    // rows are swapped in and out.
    const spread = (Math.max(...heights) - Math.min(...heights)) / Math.min(...heights);
    expect(spread).toBeLessThan(0.02);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.getByTestId("test-name").filter({ hasText: "test 2999" })).toBeVisible();
  });

  test("jumps to a failure that was never rendered", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("empty.trx") });
    await openCanvas(page, s);
    await s.setResults(bigRun());
    await expect(page.getByTestId("test-row").first()).toBeVisible();
    // Sorting by outcome would pull the failure to the top; file order leaves it
    // far outside the rendered window.
    await page.getByTestId("sort-by").selectOption("default");
    await expect(page.getByTestId("test-name").filter({ hasText: "test 2900" })).toHaveCount(0);

    await page.getByTestId("jump-fail").click();
    await expect(page.getByTestId("test-name").filter({ hasText: "test 2900" })).toBeVisible();
  });

  test("expands a row after scrolling into the middle of the run", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("empty.trx") });
    await openCanvas(page, s);
    await s.setResults(bigRun());
    await expect(page.getByTestId("test-row").first()).toBeVisible();

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(120);
    const row = page.getByTestId("row-header").first();
    await row.click();
    await expect(page.locator('[data-testid="row-details"]:visible')).toHaveCount(1);
    await expectNoBlankStrip(page);
  });

  // Rows are sorted, so the first screenful is all one shape. The shape filling
  // the rest of the run has to be sized before the user gets there.
  test("sizes the scrollbar for rows it hasn't rendered yet", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("empty.trx") });
    await openCanvas(page, s);
    await s.setResults([
      // Tall rows: a failure carries a message preview under its header.
      ...Array.from({ length: 30 }, (_, i) => ({
        name: "broken " + i, suite: "S", status: "fail", message: "AssertionError: nope", durationMs: 3,
      })),
      // Short rows, and far too many to have been rendered at first paint.
      ...Array.from({ length: 4000 }, (_, i) => ({
        name: "fine " + String(i).padStart(4, "0"), suite: "S", status: "pass", durationMs: 3,
      })),
    ]);
    await expect(page.getByTestId("test-row").first()).toBeVisible();

    const before = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => document.body.scrollHeight);
    expect(Math.abs(after - before) / before).toBeLessThan(0.02);
    // One trip to the bottom has to land at the bottom, not short of it.
    await expect(page.getByTestId("test-name").filter({ hasText: "fine 3999" })).toBeVisible();
  });
});
