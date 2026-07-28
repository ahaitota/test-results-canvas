import { test, expect, fixture, openCanvas } from "./canvas-server.mjs";

// The summary banner + status pills + total-duration pill.

test("banner reports how many tests are failing", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await expect(page.getByTestId("banner")).toContainText("2 of 6 tests failing");
});

test("banner shows the pass rate", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await expect(page.getByTestId("banner")).toContainText("50% pass rate");
});

test("banner reports all passing when nothing fails", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("empty.trx") });
  await openCanvas(page, s);
  await s.setResults([
    { name: "a", status: "pass", durationMs: 10 },
    { name: "b", status: "pass", durationMs: 20 },
    { name: "c", status: "pass", durationMs: 30 },
  ]);
  await expect(page.getByTestId("banner")).toContainText("All 3 tests passing");
  await expect(page.getByTestId("banner")).toContainText("100% pass rate");
});

test("passed chip shows the passed count", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await expect(page.getByTestId("chip-pass")).toHaveText("3 passed");
});

test("failed chip shows the failed count", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await expect(page.getByTestId("chip-fail")).toHaveText("2 failed");
});

test("skipped chip shows the skipped count", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await expect(page.getByTestId("chip-skip")).toHaveText("1 skipped");
});

test("total pill sums every test's duration", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await expect(page.getByTestId("total")).toHaveText("1.84 s total");
});
