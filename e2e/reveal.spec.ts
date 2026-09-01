import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";
import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchFor } from "../dist/src/reveal.js";
import type { Launch } from "../dist/src/reveal.js";

// The two shell actions, end to end: click -> POST /reveal -> the server picks
// the command for its own source set. The launcher is injected, so no file
// manager ever opens.

// A copy the test owns, so it can be deleted to make the report disappear.
function tempCopy(...names: string[]): { dir: string; paths: string[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "reveal-e2e-"));
  const paths = names.map((n) => {
    const path = join(dir, n);
    copyFileSync(get_fixture_path(n), path);
    return path;
  });
  return { dir, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test.describe("reveal and open", () => {
  test("both actions launch the shell for the loaded report", async ({ page, makeServer }) => {
    const launches: Launch[] = [];
    const s = await makeServer({
      resultsFile: get_fixture_path("mixed.trx"),
      launch: (l) => { launches.push(l); },
    });
    await openCanvas(page, s);

    await page.getByTestId("reveal-report").click();
    await expect.poll(() => launches.length).toBe(1);
    await page.getByTestId("open-report").click();
    await expect.poll(() => launches.length).toBe(2);

    // The path is the server's, and it reaches the command the platform uses.
    expect(launches[1]).toEqual(launchFor("open", s.revealTarget()!, process.platform));
    await expect(page.getByTestId("reveal-error")).toHaveCount(0);
  });

  test("a merged run points at the folder its files share", async ({ page, makeServer }) => {
    const launches: Launch[] = [];
    const files = tempCopy("merge-billing.trx", "merge-shipping.trx");
    const s = await makeServer({
      launch: (l) => { launches.push(l); },
    });
    await openCanvas(page, s);
    s.openFiles({ name: "Both projects", files: files.paths });

    await expect(page.getByTestId("group-name")).toHaveText("Both projects");
    // One act, so one button: a folder cannot be revealed and opened separately.
    await expect(page.getByTestId("reveal-report")).toHaveText("Open folder");
    await expect(page.getByTestId("open-report")).toHaveCount(0);

    await page.getByTestId("reveal-report").click();
    await expect.poll(() => launches.length).toBe(1);
    expect(launches[0].args).toEqual([files.dir]);

    files.cleanup();
  });

  test("results with no file on disk cannot be revealed", async ({ page, makeServer }) => {
    const report = tempCopy("mixed.trx");
    const s = await makeServer({ resultsFile: report.paths[0], launch: () => {} });
    await openCanvas(page, s);
    await expect(page.getByTestId("reveal-report")).toBeEnabled();

    report.cleanup();
    s.broadcast();

    await expect(page.getByTestId("reveal-report")).toBeDisabled();
    await expect(page.getByTestId("open-report")).toBeDisabled();
  });

  test("a launch that fails is shown in the canvas", async ({ page, makeServer }) => {
    const s = await makeServer({
      resultsFile: get_fixture_path("mixed.trx"),
      launch: () => { throw new Error("no opener installed"); },
    });
    await openCanvas(page, s);

    await page.getByTestId("open-report").click();
    await expect(page.getByTestId("reveal-error")).toBeVisible();
  });
});
