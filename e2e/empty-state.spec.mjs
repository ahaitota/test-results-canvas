import { test, expect, get_fixture_path, openCanvas } from "./canvas-server.mjs";

// Behaviour when no results are loaded.

test("shows the placeholder when no results are loaded", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: get_fixture_path("empty.trx") });
  await openCanvas(page, s);
  await expect(page.getByTestId("empty")).toContainText("No test results yet");
});

test("hides the toolbar when no results are loaded", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: get_fixture_path("empty.trx") });
  await openCanvas(page, s);
  await expect(page.getByTestId("toolbar")).toBeHidden();
});

test("shows no status chips when no results are loaded", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: get_fixture_path("empty.trx") });
  await openCanvas(page, s);
  await expect(page.getByTestId("chip-pass")).toHaveCount(0);
  await expect(page.getByTestId("chip-fail")).toHaveCount(0);
  await expect(page.getByTestId("chip-skip")).toHaveCount(0);
});

test("shows an empty banner when no results are loaded", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: get_fixture_path("empty.trx") });
  await openCanvas(page, s);
  await expect(page.getByTestId("banner")).toHaveText("");
});

test("renders no rows when no results are loaded", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: get_fixture_path("empty.trx") });
  await openCanvas(page, s);
  await expect(page.getByTestId("test-row")).toHaveCount(0);
});
