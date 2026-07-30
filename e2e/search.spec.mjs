import { test, expect, get_fixture_path, openCanvas } from "./canvas-server.mjs";

// Free-text search over name, class, method, framework, suite, computer, message.

test.describe("search", () => {
  test("searches by test name", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("none");
    await page.getByTestId("search").fill("Integration");
    await expect(page.getByTestId("test-row")).toHaveCount(2);
  });
  
  test("searches by class name", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.junit.xml") });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("none");
    await page.getByTestId("search").fill("Db.Repository");
    await expect(page.getByTestId("test-row")).toHaveCount(2);
  });
  
  test("searches by failure message", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("none");
    await page.getByTestId("search").fill("NullReference");
    await expect(page.getByTestId("test-row")).toHaveCount(1);
    await expect(page.getByTestId("test-name")).toHaveText("ThrowsOnNull");
  });
  
  test("clearing the search restores every row", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("none");
    await page.getByTestId("search").fill("Integration");
    await expect(page.getByTestId("test-row")).toHaveCount(2);
    await page.getByTestId("search").fill("");
    await expect(page.getByTestId("test-row")).toHaveCount(6);
  });
  
  test("shows an empty state when nothing matches", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
    await openCanvas(page, s);
    await page.getByTestId("search").fill("zzz-no-such-test");
    await expect(page.getByTestId("test-row")).toHaveCount(0);
    await expect(page.getByTestId("empty")).toContainText("No tests match");
  });
});
