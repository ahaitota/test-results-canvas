import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";
import type { Page } from "@playwright/test";

// Expansion is keyed by row identity, not array position: it follows a test across a
// live refresh and collapses when the row it belonged to is gone.

const rowFor = (page: Page, name: string) => page.getByTestId("test-row").filter({ hasText: name });
const openDetails = (page: Page) => page.locator('[data-testid="row-details"]:visible');

const RUN = [
  { name: "alpha", status: "pass", durationMs: 5 },
  { name: "beta", status: "fail", message: "boom" },
];

test.describe("expansion across refreshes", () => {
  test("an expanded row stays expanded when the same run is pushed again", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("empty.trx") });
    await openCanvas(page, s);

    await s.setResults(RUN);
    await expect(page.getByTestId("test-row")).toHaveCount(2);
    await rowFor(page, "alpha").getByTestId("row-header").click();
    await expect(rowFor(page, "alpha").getByTestId("row-details")).toBeVisible();

    // Same two rows plus a new one, so the refresh is observable.
    await s.setResults([...RUN, { name: "gamma", status: "pass", durationMs: 7 }]);
    await expect(page.getByTestId("test-row")).toHaveCount(3);

    await expect(rowFor(page, "alpha").getByTestId("row-details")).toBeVisible();
    await expect(rowFor(page, "gamma").getByTestId("row-details")).toBeHidden();
  });

  test("expansion does not transfer to an unrelated row taking the same position", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("empty.trx") });
    await openCanvas(page, s);

    await s.setResults([{ name: "alpha", status: "pass", durationMs: 5 }]);
    await rowFor(page, "alpha").getByTestId("row-header").click();
    await expect(rowFor(page, "alpha").getByTestId("row-details")).toBeVisible();

    await s.setResults([{ name: "zeta", status: "pass", durationMs: 9 }]);
    await expect(rowFor(page, "zeta")).toHaveCount(1);
    await expect(rowFor(page, "alpha")).toHaveCount(0);

    await expect(openDetails(page)).toHaveCount(0);
  });

  test("Show more does not transfer to an unrelated row either", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("empty.trx") });
    await openCanvas(page, s);

    await s.setResults([{ name: "alpha", status: "pass", durationMs: 5 }]);
    await rowFor(page, "alpha").getByTestId("row-header").click();
    await rowFor(page, "alpha").getByTestId("show-more").click();
    await expect(rowFor(page, "alpha").getByTestId("row-secondary")).toBeVisible();

    await s.setResults([{ name: "zeta", status: "pass", durationMs: 9 }]);
    await expect(rowFor(page, "zeta")).toHaveCount(1);

    await expect(page.locator('[data-testid="row-secondary"]:visible')).toHaveCount(0);
  });

  test("picking a different file collapses the expanded row", async ({ page, makeServer }) => {
    const s = await makeServer({
      resultsFile: get_fixture_path("mixed.trx"),
      alsoRegister: [get_fixture_path("mixed.junit.xml")],
    });
    await openCanvas(page, s);

    await page.getByTestId("test-row").first().getByTestId("row-header").click();
    await expect(openDetails(page)).toHaveCount(1);

    await page.getByTestId("file-select").selectOption("mixed.junit.xml");
    await expect(page.getByTestId("test-name").filter({ hasText: "login rejects bad password" })).toBeVisible();

    await expect(openDetails(page)).toHaveCount(0);
  });
});
