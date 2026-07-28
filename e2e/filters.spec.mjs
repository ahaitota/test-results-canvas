import { test, expect, fixture, openCanvas } from "./canvas-server.mjs";

// Pass/fail/skip status chips filter the list.

async function statuses(page) {
  return page.getByTestId("test-row").evaluateAll((els) => els.map((e) => e.dataset.status));
}

test("filters to passing tests", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await page.getByTestId("chip-pass").click();
  await expect(page.getByTestId("test-row")).toHaveCount(3);
  expect((await statuses(page)).every((x) => x === "pass")).toBe(true);
});

test("filters to failing tests", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await page.getByTestId("chip-fail").click();
  await expect(page.getByTestId("test-row")).toHaveCount(2);
  expect((await statuses(page)).every((x) => x === "fail")).toBe(true);
});

test("filters to skipped tests", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await page.getByTestId("chip-skip").click();
  await expect(page.getByTestId("test-row")).toHaveCount(1);
  expect((await statuses(page)).every((x) => x === "skip")).toBe(true);
});

test("toggles a filter back off", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await page.getByTestId("chip-fail").click();
  await expect(page.getByTestId("test-row")).toHaveCount(2);
  await page.getByTestId("chip-fail").click();
  await expect(page.getByTestId("test-row")).toHaveCount(6);
});

test("combines two filters", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await page.getByTestId("chip-pass").click();
  await page.getByTestId("chip-fail").click();
  await expect(page.getByTestId("test-row")).toHaveCount(5);
  expect((await statuses(page)).every((x) => x === "pass" || x === "fail")).toBe(true);
});

test("filters via the Enter key on a chip", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await page.getByTestId("chip-fail").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("test-row")).toHaveCount(2);
});

test("filters via the Space key on a chip", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await page.getByTestId("chip-skip").focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("test-row")).toHaveCount(1);
});

test("updates the showing counter when filtered", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await expect(page.getByTestId("showing")).toHaveText("");
  await page.getByTestId("chip-fail").click();
  await expect(page.getByTestId("showing")).toHaveText("Showing 2 of 6");
});
