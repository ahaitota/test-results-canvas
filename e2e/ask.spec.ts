import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";
import type { Page } from "@playwright/test";
import type { AskRequest } from "../dist/src/server.js";

// The button is the panel's one channel back into the conversation, so these
// cover the whole chain: click -> POST /ask -> server composes -> onAsk fires.

const RUN = [
  { name: "adds two numbers", status: "pass", durationMs: 5 },
  { name: "rejects negative amount", status: "fail", message: "Expected ArgumentException" },
];

const rowFor = (page: Page, name: string) => page.getByTestId("test-row").filter({ hasText: name });

// Open a row's details so the button inside them is visible.
async function expand(page: Page, name: string) {
  await rowFor(page, name).getByTestId("row-header").click();
}

test.describe("ask agent", () => {
  test("only failed rows offer the button", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("empty.trx"), onAsk: () => {} });
    await openCanvas(page, s);
    s.setResults(RUN);
    await expect(page.getByTestId("test-row")).toHaveCount(2);

    await expand(page, "adds two numbers");
    await expand(page, "rejects negative amount");

    await expect(rowFor(page, "rejects negative amount").getByTestId("ask-agent")).toBeVisible();
    await expect(rowFor(page, "adds two numbers").getByTestId("ask-agent")).toHaveCount(0);
  });

  test("clicking sends exactly one message, composed by the server", async ({ page, makeServer }) => {
    const asks: AskRequest[] = [];
    const s = await makeServer({
      resultsFile: get_fixture_path("empty.trx"),
      onAsk: (req) => { asks.push(req); },
    });
    await openCanvas(page, s);
    s.setResults(RUN);
    await expect(page.getByTestId("test-row")).toHaveCount(2);

    await expand(page, "rejects negative amount");
    const button = rowFor(page, "rejects negative amount").getByTestId("ask-agent");
    await button.click();

    await expect(button).toHaveAttribute("data-ask-state", "sent");
    expect(asks).toHaveLength(1);
    expect(asks[0].test?.name).toBe("rejects negative amount");
    // The page sent a row reference; the prompt is the server's own words.
    expect(asks[0].prompt).toContain("rejects negative amount");
    expect(asks[0].prompt).toContain("Expected ArgumentException");
  });

  test("the button returns to idle so the row can be asked about again", async ({ page, makeServer }) => {
    const asks: AskRequest[] = [];
    const s = await makeServer({
      resultsFile: get_fixture_path("empty.trx"),
      onAsk: (req) => { asks.push(req); },
    });
    await openCanvas(page, s);
    s.setResults(RUN);
    await expand(page, "rejects negative amount");

    const button = rowFor(page, "rejects negative amount").getByTestId("ask-agent");
    await button.click();
    await expect(button).toHaveAttribute("data-ask-state", "sent");
    await expect(button).toHaveAttribute("data-ask-state", "idle");

    await button.click();
    await expect(button).toHaveAttribute("data-ask-state", "sent");
    expect(asks).toHaveLength(2);
  });

  test("a host that cannot deliver is reported rather than silently swallowed", async ({ page, makeServer }) => {
    const s = await makeServer({
      resultsFile: get_fixture_path("empty.trx"),
      onAsk: () => { throw new Error("session gone"); },
    });
    await openCanvas(page, s);
    s.setResults(RUN);
    await expand(page, "rejects negative amount");

    const button = rowFor(page, "rejects negative amount").getByTestId("ask-agent");
    await button.click();
    await expect(button).toHaveAttribute("data-ask-state", "error");
  });

  // A refusal at least comes back as a response. When the request never lands --
  // a panel closing mid-click, a dropped connection -- fetch() rejects instead,
  // and an unhandled rejection would leave the button stuck on "Asking…".
  test("a request that never arrives is reported, not thrown", async ({ page, makeServer }) => {
    const asks: AskRequest[] = [];
    const s = await makeServer({
      resultsFile: get_fixture_path("empty.trx"),
      onAsk: (req) => { asks.push(req); },
    });
    await openCanvas(page, s);
    s.setResults(RUN);
    await expand(page, "rejects negative amount");
    await page.route((url) => url.pathname === "/ask", (route) => route.abort());

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    const button = rowFor(page, "rejects negative amount").getByTestId("ask-agent");
    await button.click();

    await expect(button).toHaveAttribute("data-ask-state", "error");
    expect(asks).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  test("clicking the button does not collapse the row", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("empty.trx"), onAsk: () => {} });
    await openCanvas(page, s);
    s.setResults(RUN);
    await expand(page, "rejects negative amount");

    const row = rowFor(page, "rejects negative amount");
    await row.getByTestId("ask-agent").click();
    await expect(row.getByTestId("row-details")).toBeVisible();
  });

  // A hover rule naming an undefined custom property is not ignored: it resets
  // the background to its initial value, which is transparent.
  test("hovering keeps a visible background in both themes", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("empty.trx"), onAsk: () => {} });
    await openCanvas(page, s);
    s.setResults(RUN);
    await expand(page, "rejects negative amount");

    const button = rowFor(page, "rejects negative amount").getByTestId("ask-agent");
    const bg = () => button.evaluate((e) => getComputedStyle(e).backgroundColor);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      await page.mouse.move(0, 0);
      const resting = await bg();
      await button.hover();
      const hovered = await bg();
      expect(hovered, `${theme} hover background`).not.toBe("rgba(0, 0, 0, 0)");
      expect(hovered, `${theme} hover is distinguishable`).not.toBe(resting);
    }
  });
});
