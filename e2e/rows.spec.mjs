import { test, expect, get_fixture_path, openCanvas } from "./canvas-server.mjs";

// Row expansion via header, toggle arrow and message preview; Show more/less.

test("expands a row via its header", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
  await openCanvas(page, s);
  const row = page.getByTestId("test-row").filter({ hasText: "AddsTwoNumbers" });
  await expect(row.getByTestId("row-details")).toBeHidden();

  await row.getByTestId("row-header").click();
  await expect(row.getByTestId("row-details")).toBeVisible();
  await expect(row.getByTestId("row-toggle")).toHaveAttribute("aria-expanded", "true");
});

test("collapses an expanded row via its header", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
  await openCanvas(page, s);
  const row = page.getByTestId("test-row").filter({ hasText: "AddsTwoNumbers" });

  await row.getByTestId("row-header").click();
  await expect(row.getByTestId("row-details")).toBeVisible();
  await row.getByTestId("row-header").click();
  await expect(row.getByTestId("row-details")).toBeHidden();
  await expect(row.getByTestId("row-toggle")).toHaveAttribute("aria-expanded", "false");
});

test("expands a row via the toggle arrow", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
  await openCanvas(page, s);
  const row = page.getByTestId("test-row").filter({ hasText: "DividesNumbers" });
  await expect(row.getByTestId("row-details")).toBeHidden();

  await row.getByTestId("row-toggle").click();
  await expect(row.getByTestId("row-details")).toBeVisible();
});

test("expands a failing row by clicking its message preview", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
  await openCanvas(page, s);
  const row = page.getByTestId("test-row").filter({ hasText: "ThrowsOnNull" });
  await expect(row.getByTestId("row-details")).toBeHidden();

  await row.getByTestId("msg-preview").click();
  await expect(row.getByTestId("row-details")).toBeVisible();
});

test("reveals secondary fields with Show more", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
  await openCanvas(page, s);
  const row = page.getByTestId("test-row").filter({ hasText: "AddsTwoNumbers" });
  await row.getByTestId("row-header").click();

  await expect(row.getByTestId("row-secondary")).toBeHidden();
  await row.getByTestId("show-more").click();
  await expect(row.getByTestId("row-secondary")).toBeVisible();
  await expect(row.getByTestId("show-more")).toContainText("Show less");
});

test("hides secondary fields again with Show less", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
  await openCanvas(page, s);
  const row = page.getByTestId("test-row").filter({ hasText: "AddsTwoNumbers" });
  await row.getByTestId("row-header").click();

  await row.getByTestId("show-more").click();
  await expect(row.getByTestId("row-secondary")).toBeVisible();
  await row.getByTestId("show-more").click();
  await expect(row.getByTestId("row-secondary")).toBeHidden();
  await expect(row.getByTestId("show-more")).toContainText("Show more");
});

test("hides the message preview once the row is expanded", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
  await openCanvas(page, s);
  const row = page.getByTestId("test-row").filter({ hasText: "ThrowsOnNull" });
  await expect(row.getByTestId("msg-preview")).toBeVisible();

  await row.getByTestId("row-header").click();
  await expect(row.getByTestId("msg-preview")).toBeHidden();
});
