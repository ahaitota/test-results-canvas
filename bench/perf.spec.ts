// Rendering benchmark: boots the real canvas server over a synthetic run and
// times what the user actually waits for -- first render, keystroke, sort,
// filter, group, scroll pacing, and how much DOM the list holds.
//
// Everything is measured inside the page, and interaction numbers are the
// median of several samples.
//
// Run with:  npm run bench                                  (1k and 10k)
//            BENCH_SCALES=100,1000,10000,50000 npm run bench
import { test, expect } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { createResultsServer } from "../dist/src/server.js";
import { ensureFixture } from "./gen-fixtures.js";

// Budgets per scale, in ms. A scale with no entry is reported but not enforced.
interface Budget {
  render: number;
  keystroke: number;
  settle: number;
  sort: number;
  filter: number;
  group: number;
  scroll: number;
  // The point of virtualizing: DOM size stops tracking the run size.
  rows: number;
}

const BUDGETS: Record<number, Budget> = {
  100: { render: 100, keystroke: 16, settle: 400, sort: 100, filter: 100, group: 100, scroll: 50, rows: 120 },
  1_000: { render: 100, keystroke: 16, settle: 400, sort: 150, filter: 150, group: 150, scroll: 50, rows: 200 },
  10_000: { render: 250, keystroke: 16, settle: 600, sort: 500, filter: 500, group: 500, scroll: 50, rows: 200 },
};

const SCALES = (process.env.BENCH_SCALES || "1000,10000")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

const SAMPLES = Math.max(1, Number(process.env.BENCH_SAMPLES || 5));

interface BenchMarks {
  firstMessage: number;
  firstRows: number;
  firstPaint: number;
}

declare global {
  interface Window { __bench?: BenchMarks }
}

// Runs before the app's own scripts: records when the results payload arrived
// and when the first rows reached the screen.
function initScript(): void {
  const marks: BenchMarks = { firstMessage: 0, firstRows: 0, firstPaint: 0 };
  window.__bench = marks;

  const Original = window.EventSource;
  const Wrapped = function (url: string, init?: EventSourceInit) {
    const source = new Original(url, init);
    // Registered before the app assigns onmessage, so it always sees the first.
    source.addEventListener("message", () => {
      if (!marks.firstMessage) marks.firstMessage = performance.now();
    });
    return source;
  } as unknown as typeof EventSource;
  Wrapped.prototype = Original.prototype;
  window.EventSource = Wrapped;

  const observer = new MutationObserver(() => {
    if (marks.firstRows || !document.querySelector('[data-testid="test-row"]')) return;
    marks.firstRows = performance.now();
    observer.disconnect();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      marks.firstPaint = performance.now();
    }));
  });
  const attach = () => {
    if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });
    else requestAnimationFrame(attach);
  };
  attach();
}

// A user gesture, described so it can cross into the page as plain data.
type Action =
  | { kind: "set"; testId: string; value: string }
  | { kind: "click"; testId: string };

interface Timing {
  // How long the synchronous event handler held the main thread.
  handlerMs: number;
  // Gesture -> the DOM update committed and laid out, without yielding. This is
  // the number that has to fit in a frame.
  blockMs: number;
  // Gesture -> the list actually showing the new content.
  settleMs: number;
}

// Perform one gesture in the page and time it.
function measure(page: Page, action: Action, settleTimeout: number): Promise<Timing> {
  return page.evaluate(async ({ action, settleTimeout }) => {
    const perform = () => {
      const el = document.querySelector(`[data-testid="${action.testId}"]`);
      if (!el) throw new Error(`no element with data-testid=${action.testId}`);
      if (action.kind === "click") {
        (el as HTMLElement).click();
        return;
      }
      (el as HTMLInputElement | HTMLSelectElement).value = action.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const list = document.getElementById("list");
    const changed = new Promise<void>((resolve) => {
      if (!list) {
        resolve();
        return;
      }
      const observer = new MutationObserver(() => {
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, settleTimeout);
      observer.observe(list, { childList: true, subtree: true, characterData: true, attributes: true });
    });

    const started = performance.now();
    perform();
    const handlerMs = performance.now() - started;
    // Preact commits in a microtask; reading a layout property then flushes
    // style and layout. Everything up to here is one uninterrupted block.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    void document.body.offsetHeight;
    const blockMs = performance.now() - started;
    await changed;
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    return { handlerMs, blockMs, settleMs: performance.now() - started };
  }, { action, settleTimeout });
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// Repeat a gesture (cycling through variants so no sample hits a warm cache)
// and keep the median of each metric.
async function sample(page: Page, actions: Action[], settleTimeout = 10_000): Promise<Timing> {
  const runs: Timing[] = [];
  for (let i = 0; i < SAMPLES; i++) runs.push(await measure(page, actions[i % actions.length], settleTimeout));
  return {
    handlerMs: median(runs.map((r) => r.handlerMs)),
    blockMs: median(runs.map((r) => r.blockMs)),
    settleMs: median(runs.map((r) => r.settleMs)),
  };
}

// Scroll the whole list a frame at a time and report how long the frames took.
// A gesture-and-wait measurement cannot see scroll cost.
function scrollSweep(page: Page, frames = 40, step = 700): Promise<{ p95: number; max: number }> {
  return page.evaluate(async ({ frames, step }) => {
    window.scrollTo(0, 0);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const gaps: number[] = [];
    let last = performance.now();
    for (let i = 0; i < frames; i++) {
      window.scrollBy(0, step);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }
    gaps.sort((a, b) => a - b);
    return { p95: gaps[Math.floor(gaps.length * 0.95)], max: gaps[gaps.length - 1] };
  }, { frames, step });
}

const setValue = (testId: string, value: string): Action => ({ kind: "set", testId, value });

// Put the panel back in its default view, so each phase is timed against the
// whole run rather than what an earlier phase left filtered.
async function reset(page: Page): Promise<void> {
  await page.evaluate(() => {
    const search = document.querySelector('[data-testid="search"]') as HTMLInputElement | null;
    if (search && search.value) {
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    }
    for (const chip of document.querySelectorAll<HTMLElement>(".summary .pill.active")) chip.click();
    for (const [testId, value] of [["group-by", "suite"], ["sort-by", "status"]] as const) {
      const select = document.querySelector(`[data-testid="${testId}"]`) as HTMLSelectElement | null;
      if (!select || select.value === value) continue;
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);
}

interface Metric {
  name: string;
  value: number;
  budget: number | null;
  unit: "ms" | "count";
}

function report(info: TestInfo, count: number, metrics: Metric[]): string {
  const lines = [
    "",
    `  ${count.toLocaleString("en-US")} tests`,
    `  ${"metric".padEnd(24)}${"measured".padStart(10)}${"budget".padStart(10)}`,
    `  ${"-".repeat(44)}`,
  ];
  for (const m of metrics) {
    const value = m.unit === "ms" ? `${m.value.toFixed(1)} ms` : String(Math.round(m.value));
    const budget = m.budget == null ? "-" : m.unit === "ms" ? `${m.budget} ms` : String(m.budget);
    const over = m.budget != null && m.value > m.budget ? "  OVER" : "";
    lines.push(`  ${m.name.padEnd(24)}${value.padStart(10)}${budget.padStart(10)}${over}`);
  }
  const text = lines.join("\n");
  info.annotations.push({ type: "bench", description: text });
  return text;
}

for (const count of SCALES) {
  test(`renders and stays responsive with ${count.toLocaleString("en-US")} tests`, async ({ page }, info) => {
    test.setTimeout(300_000);
    const budget: Budget | undefined = BUDGETS[count];

    const server = await createResultsServer({ port: 0, watch: false, resultsFile: ensureFixture(count) });
    try {
      await page.addInitScript(initScript);
      await page.goto(server.url);
      await page.locator('[data-testid="test-row"]').first().waitFor({ timeout: 240_000 });

      const initial = await page.evaluate(() => new Promise<{ renderMs: number; paintMs: number }>((resolve) => {
        const marks = window.__bench as BenchMarks;
        const check = () => {
          if (marks.firstPaint) resolve({ renderMs: marks.firstRows - marks.firstMessage, paintMs: marks.firstPaint - marks.firstMessage });
          else requestAnimationFrame(check);
        };
        check();
      }));

      // Typing: the character must land on the next frame.
      const keystroke = await sample(page, ["#7", "#71", "#712", "#7", "#71"].map((q) => setValue("search", q)));
      await reset(page);

      const sort = await sample(page, ["duration", "name", "status", "default"].map((v) => setValue("sort-by", v)));
      await reset(page);

      const filter = await sample(page, [{ kind: "click", testId: "chip-fail" }, { kind: "click", testId: "chip-fail" }]);
      await reset(page);

      const group = await sample(page, ["class", "status", "none", "suite"].map((v) => setValue("group-by", v)));
      await reset(page);

      // The list only mutates on scroll once virtualized, so scrolling is
      // judged on frame pacing.
      const scroll = await scrollSweep(page);
      await reset(page);

      const dom = await page.evaluate(() => ({
        rows: document.querySelectorAll('[data-testid="test-row"]').length,
        nodes: document.getElementById("list")?.getElementsByTagName("*").length ?? 0,
      }));

      const metrics: Metric[] = [
        { name: "render (payload->rows)", value: initial.renderMs, budget: budget?.render ?? null, unit: "ms" },
        { name: "render (->painted)", value: initial.paintMs, budget: null, unit: "ms" },
        { name: "keystroke (blocking)", value: keystroke.blockMs, budget: budget?.keystroke ?? null, unit: "ms" },
        { name: "keystroke (handler)", value: keystroke.handlerMs, budget: null, unit: "ms" },
        { name: "search settle", value: keystroke.settleMs, budget: budget?.settle ?? null, unit: "ms" },
        { name: "sort change", value: sort.settleMs, budget: budget?.sort ?? null, unit: "ms" },
        { name: "status filter", value: filter.settleMs, budget: budget?.filter ?? null, unit: "ms" },
        { name: "group change", value: group.settleMs, budget: budget?.group ?? null, unit: "ms" },
        { name: "scroll frame p95", value: scroll.p95, budget: budget?.scroll ?? null, unit: "ms" },
        { name: "scroll frame max", value: scroll.max, budget: null, unit: "ms" },
        { name: "rows in the DOM", value: dom.rows, budget: budget?.rows ?? null, unit: "count" },
        { name: "nodes under #list", value: dom.nodes, budget: null, unit: "count" },
      ];
      console.log(report(info, count, metrics));

      // Soft, so one blown budget still reports every other number.
      for (const m of metrics) {
        if (m.budget != null) expect.soft(m.value, m.name).toBeLessThanOrEqual(m.budget);
      }
    } finally {
      await server.close();
    }
  });
}
