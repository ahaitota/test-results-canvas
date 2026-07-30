import { test, expect, get_fixture_path, openCanvas } from "./canvas-server.mjs";

// Reload via the server's `reload` SSE event, and via fresh navigation.

test.describe("reload and reopen", () => {
  test("reloads the page when the server sends a reload event", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-row")).toHaveCount(6);
  
    // Sentinel is cleared by a real reload (fresh JS context).
    await page.evaluate(() => { window.__keep = true; });
    const reloaded = page.waitForEvent("load");
    await s.reload();
    await reloaded;
  
    expect(await page.evaluate(() => window.__keep === undefined)).toBe(true);
    await expect(page.getByTestId("test-row")).toHaveCount(6);
  });
  
  test("a reopened canvas shows the current results in the default view", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
    await openCanvas(page, s);
  
    const row = () => page.getByTestId("test-row").filter({ hasText: "AddsTwoNumbers" });
    await row().getByTestId("row-header").click();
    await expect(row().getByTestId("row-details")).toBeVisible();
  
    // Reopen = a fresh navigation to the same server.
    await openCanvas(page, s);
  
    await expect(page.getByTestId("test-row")).toHaveCount(6);
    await expect(row().getByTestId("row-details")).toBeHidden();
  });
});
