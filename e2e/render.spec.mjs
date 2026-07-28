import { test, expect, fixture, openCanvas } from "./canvas-server.mjs";

// Initial render: title, rows, statuses, failure message, live SSE push.

test("shows the run title", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx"), title: "Mixed Suite" });
  await openCanvas(page, s);
  await expect(page.getByTestId("title")).toHaveText("Mixed Suite");
});

test("renders one row per test", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await expect(page.getByTestId("test-row")).toHaveCount(6);
});

test("tags each row with its status", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await page.getByTestId("group-by").selectOption("none");
  const statuses = await page.getByTestId("test-row").evaluateAll(
    (els) => els.map((e) => e.dataset.status).sort()
  );
  expect(statuses).toEqual(["fail", "fail", "pass", "pass", "pass", "skip"]);
});

test("shows a failing test's message inline", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  // Default sort is by outcome, so a failing row leads.
  await expect(page.getByTestId("msg-preview").first()).toContainText("NullReferenceException");
});

test("renders a JUnit run in the browser", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.junit.xml") });
  await openCanvas(page, s);
  await expect(page.getByTestId("test-row")).toHaveCount(5);
  await expect(page.getByTestId("test-name").filter({ hasText: "login rejects bad password" })).toBeVisible();
});

test("populates live when the server pushes results over SSE", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("empty.trx") });
  await openCanvas(page, s);
  await expect(page.getByTestId("empty")).toBeVisible();

  await s.setResults([
    { name: "alpha", status: "pass", durationMs: 5 },
    { name: "beta", status: "fail", message: "boom" },
  ]);

  await expect(page.getByTestId("test-row")).toHaveCount(2);
  await expect(page.getByTestId("banner")).toContainText("1 of 2 tests failing");
});
