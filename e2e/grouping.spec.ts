import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";

// The Group dropdown offers none/status/namespace/class/suite/framework.

test.describe("grouping", () => {
  test("group by none shows a flat list", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.trx") });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("none");
    await expect(page.getByTestId("group")).toHaveCount(0);
    await expect(page.getByTestId("test-row")).toHaveCount(6);
  });
  
  test("groups by status", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.junit.xml") });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("status");
    await expect(page.getByTestId("group")).toHaveCount(3);
    await expect(page.getByTestId("group-header").filter({ hasText: "Passed" })).toBeVisible();
    await expect(page.getByTestId("group-header").filter({ hasText: "Failed" })).toBeVisible();
    await expect(page.getByTestId("group-header").filter({ hasText: "Skipped" })).toBeVisible();
  });
  
  test("groups by namespace", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.junit.xml") });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("namespace");
    await expect(page.getByTestId("group")).toHaveCount(2);
    await expect(page.getByTestId("group-header").filter({ hasText: "Api" })).toBeVisible();
    await expect(page.getByTestId("group-header").filter({ hasText: "Db" })).toBeVisible();
  });
  
  test("groups by class", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.junit.xml") });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("class");
    await expect(page.getByTestId("group")).toHaveCount(2);
    await expect(page.getByTestId("group-header").filter({ hasText: "Api.Smoke" })).toBeVisible();
    await expect(page.getByTestId("group-header").filter({ hasText: "Db.Repository" })).toBeVisible();
  });
  
  test("groups by suite (the default)", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.junit.xml") });
    await openCanvas(page, s);
    await expect(page.getByTestId("group")).toHaveCount(2);
    await expect(page.getByTestId("group-header").filter({ hasText: "Api.SmokeSuite" })).toBeVisible();
    await expect(page.getByTestId("group-header").filter({ hasText: "Db.RepositoryTests" })).toBeVisible();
  });
  
  test("groups by framework", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("frameworks.trx") });
    await openCanvas(page, s);
    await page.getByTestId("group-by").selectOption("framework");
    await expect(page.getByTestId("group")).toHaveCount(2);
    await expect(page.getByTestId("group-header").filter({ hasText: "net8.0" })).toBeVisible();
    await expect(page.getByTestId("group-header").filter({ hasText: "net472" })).toBeVisible();
  });
  
  test("collapses a group", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.junit.xml") });
    await openCanvas(page, s);
    const db = () => page.getByTestId("group").filter({ hasText: "Db.RepositoryTests" });
    await expect(db().getByTestId("group-body")).toBeVisible();
    await db().getByTestId("group-header").click();
    await expect(db().getByTestId("group-body")).toBeHidden();
  });
  
  test("expands a collapsed group", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("mixed.junit.xml") });
    await openCanvas(page, s);
    const db = () => page.getByTestId("group").filter({ hasText: "Db.RepositoryTests" });
    await db().getByTestId("group-header").click();
    await expect(db().getByTestId("group-body")).toBeHidden();
    await db().getByTestId("group-header").click();
    await expect(db().getByTestId("group-body")).toBeVisible();
  });
  
  test("group collapse survives a live refresh", async ({ page, makeServer }) => {
    const s = await makeServer({
      resultsFile: get_fixture_path("mixed.junit.xml"),
      alsoRegister: [get_fixture_path("mixed-plus.junit.xml")],
    });
    await openCanvas(page, s);
  
    const db = () => page.getByTestId("group").filter({ hasText: "Db.RepositoryTests" });
    await db().getByTestId("group-header").click();
    await expect(db().getByTestId("group-body")).toBeHidden();
  
    // Push a fresh run over SSE.
    await s.loadNamed("mixed-plus.junit.xml");
    await expect(page.getByTestId("test-name").filter({ hasText: "logout clears session" })).toBeVisible();
  
    // New group node, still collapsed.
    await expect(db().getByTestId("group-body")).toBeHidden();
  });
});
