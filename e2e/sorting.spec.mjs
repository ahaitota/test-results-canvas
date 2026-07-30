import { test, expect, get_fixture_path, openCanvas } from "./canvas-server.mjs";

// Sort dropdown options.

test.describe("sorting", () => {
  test("sorts by duration, slowest first", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("none");
    await page.getByTestId("sort-by").selectOption("duration");
    await expect(page.getByTestId("test-row").first().getByTestId("test-name")).toHaveText("SlowIntegration");
  });
  
  test("sorts by name alphabetically", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("none");
    await page.getByTestId("sort-by").selectOption("name");
    await expect(page.getByTestId("test-row").first().getByTestId("test-name")).toHaveText("AddsTwoNumbers");
    await expect(page.getByTestId("test-row").last().getByTestId("test-name")).toHaveText("ThrowsOnNull");
  });
  
  test("sorts by outcome, failures first", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("none");
    await page.getByTestId("sort-by").selectOption("status");
    await expect(page.getByTestId("test-row").first()).toHaveAttribute("data-status", "fail");
  });
  
  test("default sort keeps the original file order", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("none");
    await page.getByTestId("sort-by").selectOption("default");
    await expect(page.getByTestId("test-row").first().getByTestId("test-name")).toHaveText("AddsTwoNumbers");
  });
});
