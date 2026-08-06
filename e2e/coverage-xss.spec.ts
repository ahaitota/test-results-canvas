// A coverage report is attacker-controlled input, and so is any source file it
// points at. Both end up on screen, so both are asserted here: injected markup
// must arrive as text, and no handler it tries to install may ever run.
import type { Locator } from "@playwright/test";
import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";

async function eventHandlerAttrs(locator: Locator): Promise<string[]> {
  const attrs = await locator.evaluateAll((els) => els.flatMap((el) => el.getAttributeNames()));
  return attrs.filter((a) => a.startsWith("on"));
}

async function firedPayloads(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return [
      "__ROOT_XSS__", "__PKG_XSS__", "__PATH_XSS__", "__ATTR_XSS__", "__STYLE_XSS__",
      "__SRC_XSS", "__SRC_SCRIPT_XSS", "__SRC_COMMENT_XSS",
    ].filter((k) => w[k] !== undefined);
  });
}

test.describe("hostile coverage reports", () => {
  test("markup in a report path is displayed, not parsed", async ({ page, makeServer }) => {
    const s = await makeServer({ coverageFile: get_fixture_path("coverage/xss.cobertura.xml"), coverage: true, gitExec: null });
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    await expect(page.getByTestId("coverage-view")).toBeVisible();
    expect(await eventHandlerAttrs(page.getByTestId("coverage-file"))).toEqual([]);
    expect(await eventHandlerAttrs(page.getByTestId("coverage-folder"))).toEqual([]);
    expect(await page.locator("img").count()).toBe(0);
    expect(await firedPayloads(page)).toEqual([]);
  });

  test("injected handlers do not run when the rows are interacted with", async ({ page, makeServer }) => {
    const s = await makeServer({ coverageFile: get_fixture_path("coverage/xss.cobertura.xml"), coverage: true, gitExec: null });
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    for (const id of ["coverage-file", "coverage-folder", "coverage-hotspot"]) {
      for (const el of await page.getByTestId(id).all()) await el.dispatchEvent("mouseover");
    }
    expect(await firedPayloads(page)).toEqual([]);
  });

  test("a hostile path still reads literally instead of being truncated", async ({ page, makeServer }) => {
    const s = await makeServer({ coverageFile: get_fixture_path("coverage/xss.cobertura.xml"), coverage: true, gitExec: null });
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    // The other direction: escaping must not leak "&quot;" into the visible UI,
    // nor cut the name off at its first quote.
    const titles = await page.getByTestId("coverage-file").locator(".cov-name")
      .evaluateAll((els) => els.map((el) => el.getAttribute("title")));
    expect(titles.some((t) => t?.includes('onerror="window.__PATH_XSS__=1"'))).toBe(true);
    expect(titles.some((t) => t?.includes("&quot;"))).toBe(false);
  });

  test("markup inside a source file is escaped by the gutter view", async ({ page, makeServer }) => {
    const s = await makeServer({ coverageFile: get_fixture_path("coverage/xss-source.cobertura.xml"), coverage: true, gitExec: null });
    await openCanvas(page, s);
    await page.getByTestId("tab-coverage").click();

    await page.getByTestId("coverage-files").getByTestId("coverage-file").first().click();
    const view = page.getByTestId("source-view").first();
    await expect(view).toBeVisible();

    // The payload has to be readable as code, which is the whole point of the
    // view, while never becoming an element.
    await expect(view).toContainText("window.__SRC_XSS=1");
    expect(await view.locator("img, script").count()).toBe(0);
    expect(await eventHandlerAttrs(view.locator("*"))).toEqual([]);
    expect(await firedPayloads(page)).toEqual([]);
  });
});
