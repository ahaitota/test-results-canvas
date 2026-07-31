import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";

// The file-select dropdown chooses which results file the panel displays.

test.describe("file picker", () => {
  test("lists every registered file in the dropdown", async ({ page, makeServer }) => {
    const s = await makeServer({
      resultsFile: get_fixture_path("mixed.trx"),
      alsoRegister: [get_fixture_path("mixed.junit.xml")],
    });
    await openCanvas(page, s);
  
    const options = page.getByTestId("file-select").locator("option");
    await expect(options.filter({ hasText: "mixed.trx" })).toHaveCount(1);
    await expect(options.filter({ hasText: "mixed.junit.xml" })).toHaveCount(1);
  });
  
  test("switches the displayed results when a file is picked", async ({ page, makeServer }) => {
    const s = await makeServer({
      resultsFile: get_fixture_path("mixed.trx"),
      alsoRegister: [get_fixture_path("mixed.junit.xml")],
    });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-name").filter({ hasText: "AddsTwoNumbers" })).toBeVisible();
  
    await page.getByTestId("file-select").selectOption("mixed.junit.xml");
  
    await expect(page.getByTestId("test-name").filter({ hasText: "login rejects bad password" })).toBeVisible();
    await expect(page.getByTestId("test-name").filter({ hasText: "AddsTwoNumbers" })).toHaveCount(0);
  });
});
