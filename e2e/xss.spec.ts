import type { Locator } from "@playwright/test";
import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";

// A quote in a test/class name can close a title="..." attribute and inject a
// live event handler. Asserts on the DOM, so it survives a renderer rewrite.

const PAYLOAD_NAME = 'probe" onmouseover="window.__XSS_NAME=1';

// These elements never legitimately carry an on* handler, so any is an injection.
async function eventHandlerAttrs(locator: Locator): Promise<string[]> {
  const attrs = await locator.evaluateAll((els) => els.flatMap((el) => el.getAttributeNames()));
  return attrs.filter((a) => a.startsWith("on"));
}

test.describe("attribute injection from result files", () => {
  test("a quote in a test name does not create new attributes", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("xss.trx") });
    await openCanvas(page, s);

    expect(await eventHandlerAttrs(page.getByTestId("test-name"))).toEqual([]);
  });

  test("a quote in a class name does not create new attributes on the group header", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("xss.trx") });
    await openCanvas(page, s);

    // Rows are grouped by suite (which falls back to className) by default.
    expect(await eventHandlerAttrs(page.getByTestId("group-header"))).toEqual([]);
  });

  test("an injected handler does not run when elements are interacted with", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("xss.trx") });
    await openCanvas(page, s);

    for (const id of ["test-name", "group-header", "test-row"]) {
      for (const el of await page.getByTestId(id).all()) await el.dispatchEvent("mouseover");
    }

    const fired = await page.evaluate(() => {
      const w = window as unknown as { __XSS_NAME?: unknown; __XSS_GROUP?: unknown };
      return { name: w.__XSS_NAME, group: w.__XSS_GROUP };
    });
    expect(fired).toEqual({ name: undefined, group: undefined });
  });

  test("quotes still display literally after escaping", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("xss.trx") });
    await openCanvas(page, s);

    // The other direction: escaping must not leak "&quot;" into the visible UI,
    // and must not truncate a name at its first quote.
    await expect(page.getByText('quoted "name" shows literally')).toBeVisible();

    const titles = await page.getByTestId("test-name").evaluateAll((els) => els.map((el) => el.getAttribute("title")));
    expect(titles).toContain(PAYLOAD_NAME);
  });
});
