import { test, expect, fixture, openCanvas } from "./canvas-server.mjs";

// "Next failure" button and re-expand a collapsed group holding a failure.

test("disables the jump button when there are no failures", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("empty.trx") });
  await openCanvas(page, s);
  await s.setResults([
    { name: "a", status: "pass", durationMs: 1 },
    { name: "b", status: "pass", durationMs: 2 },
  ]);
  await expect(page.getByTestId("jump-fail")).toBeDisabled();
});

test("enables the jump button when there are failures", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.trx") });
  await openCanvas(page, s);
  await expect(page.getByTestId("jump-fail")).toBeEnabled();
});

test("clicking jump re-expands a collapsed group hiding a failure", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.junit.xml") });
  await openCanvas(page, s);
  const api = () => page.getByTestId("group").filter({ hasText: "Api.SmokeSuite" });
  await api().getByTestId("group-header").click();
  await expect(api().getByTestId("group-body")).toBeHidden();

  await page.getByTestId("jump-fail").click();
  await expect(api().getByTestId("group-body")).toBeVisible();
});

test("the n key jumps to the next failure", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.junit.xml") });
  await openCanvas(page, s);
  const api = () => page.getByTestId("group").filter({ hasText: "Api.SmokeSuite" });
  await api().getByTestId("group-header").click();
  await expect(api().getByTestId("group-body")).toBeHidden();

  await page.getByTestId("title").click(); // move focus off the select
  await page.keyboard.press("n");
  await expect(api().getByTestId("group-body")).toBeVisible();
});

test("the p key jumps to the previous failure", async ({ page, makeServer }) => {
  const s = await makeServer({ resultsFile: fixture("mixed.junit.xml") });
  await openCanvas(page, s);
  const api = () => page.getByTestId("group").filter({ hasText: "Api.SmokeSuite" });
  await api().getByTestId("group-header").click();
  await expect(api().getByTestId("group-body")).toBeHidden();

  await page.getByTestId("title").click();
  await page.keyboard.press("p");
  await expect(api().getByTestId("group-body")).toBeVisible();
});
