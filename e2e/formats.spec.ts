import { test, expect, get_fixture_path, openCanvas } from "./canvas-server";
import { copyFileSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";

// The non-XML formats end to end: the server has to detect them from content and
// keep watching them for re-runs, exactly as it does for TRX/JUnit.

test.describe("cross-language report formats", () => {
  test("renders a TAP 13 report", async ({ page, makeServer }) => {
    const s = await makeServer({ resultsFile: get_fixture_path("calc.tap") });
    await openCanvas(page, s);

    await expect(page.getByTestId("test-row")).toHaveCount(3);
    await expect(page.getByTestId("test-name").filter({ hasText: "subtracts two numbers" })).toBeVisible();
    await expect(page.getByTestId("chip-fail")).toHaveText("1 failed");
    await expect(page.getByTestId("chip-skip")).toHaveText("1 skipped");
  });

  test("renders a go test JSON stream and follows the next run", async ({ page, makeServer }, testInfo) => {
    const dir = testInfo.outputPath("go");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "go-test.jsonl");
    copyFileSync(get_fixture_path("gotest.jsonl"), file);

    const s = await makeServer({ resultsFile: file, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-row")).toHaveCount(2);

    // A re-run writes the stream afresh: `go test` closes a package with its
    // own outcome, so nothing follows that within one run.
    const rerun = [
      { Time: "2024-01-01T10:05:00Z", Action: "run", Package: "example/calc", Test: "TestAddsTwoNumbers" },
      { Time: "2024-01-01T10:05:01Z", Action: "pass", Package: "example/calc", Test: "TestAddsTwoNumbers", Elapsed: 0.04 },
      { Time: "2024-01-01T10:05:01Z", Action: "skip", Package: "example/calc", Test: "TestDivides", Elapsed: 0 },
      { Time: "2024-01-01T10:05:01Z", Action: "pass", Package: "example/calc", Elapsed: 0.1 },
    ].map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(file, `${rerun}\n`, "utf8");

    await expect(page.getByTestId("test-row")).toHaveCount(2);
    await expect(page.getByTestId("test-name").filter({ hasText: "TestDivides" })).toBeVisible();
  });

  test("refreshes an Allure source when a new sibling result appears beside it", async ({ page, makeServer }, testInfo) => {
    // The Allure source shares its folder with another report, so it is not the
    // only entry there -- and a brand-new result file carries a name no entry is
    // stored under.
    const dir = testInfo.outputPath("allure");
    mkdirSync(dir, { recursive: true });
    const first = join(dir, "aaa-result.json");
    const other = join(dir, "run.xml");
    writeFileSync(first, `{"uuid":"aaa","name":"adds","status":"passed"}`, "utf8");
    writeFileSync(other, `<testsuites><testsuite name="s"><testcase name="unrelated" /></testsuite></testsuites>`, "utf8");

    const s = await makeServer({ name: "Mixed", resultsFiles: [first, other], watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-row")).toHaveCount(2);

    writeFileSync(join(dir, "bbb-result.json"), `{"uuid":"bbb","name":"subtracts","status":"failed"}`, "utf8");

    await expect(page.getByTestId("test-row")).toHaveCount(3);
    await expect(page.getByTestId("test-name").filter({ hasText: "subtracts" })).toBeVisible();
  });

  test("re-anchors an Allure source when the run that named it is replaced", async ({ page, makeServer }, testInfo) => {
    // A re-run clears the folder and writes fresh files, so the file the source
    // was anchored on no longer exists.
    const dir = testInfo.outputPath("allure-replaced");
    mkdirSync(dir, { recursive: true });
    const first = join(dir, "aaa-result.json");
    const other = join(dir, "run.xml");
    writeFileSync(first, `{"uuid":"aaa","name":"adds","status":"passed"}`, "utf8");
    writeFileSync(other, `<testsuites><testsuite name="s"><testcase name="unrelated" /></testsuite></testsuites>`, "utf8");

    const s = await makeServer({ name: "Mixed", resultsFiles: [first, other], watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-name").filter({ hasText: "adds" })).toBeVisible();

    rmSync(first);
    writeFileSync(join(dir, "ccc-result.json"), `{"uuid":"ccc","name":"divides","status":"passed"}`, "utf8");

    await expect(page.getByTestId("test-name").filter({ hasText: "divides" })).toBeVisible();
    await expect(page.getByTestId("test-name").filter({ hasText: "adds" })).toHaveCount(0);
  });

  test("keeps watching a source whose extension no folder scan would look at", async ({ page, makeServer }, testInfo) => {
    // An explicitly named file is accepted by content, so it can be called
    // anything -- and its rewrites have to reach the panel all the same, even
    // when the writer spells the name differently than the panel was opened
    // with, as Windows allows.
    const dir = testInfo.outputPath("custom-ext");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "junit.report");
    const suite = (cases: string) => `<testsuites><testsuite name="s">${cases}</testsuite></testsuites>`;
    writeFileSync(file, suite(`<testcase name="adds" />`), "utf8");

    const s = await makeServer({ resultsFile: process.platform === "win32" ? file.toUpperCase() : file, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-row")).toHaveCount(1);

    writeFileSync(file, suite(`<testcase name="adds" /><testcase name="subtracts" />`), "utf8");

    await expect(page.getByTestId("test-row")).toHaveCount(2);
  });

  test("a rewritten source is not replaced by a newer report beside it", async ({ page, makeServer }, testInfo) => {
    // Re-deriving to the folder's newest report is how a single named .trx
    // follows `dotnet test`'s per-run filenames -- but it must not fire when
    // the source itself was the thing that changed.
    const dir = testInfo.outputPath("newer-sibling");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "junit.report");
    const suite = (cases: string) => `<testsuites><testsuite name="s">${cases}</testsuite></testsuites>`;
    writeFileSync(file, suite(`<testcase name="adds" />`), "utf8");
    writeFileSync(join(dir, "unrelated.xml"), suite(`<testcase name="unrelated" />`), "utf8");

    const s = await makeServer({ resultsFile: file, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-row")).toHaveCount(1);

    writeFileSync(file, suite(`<testcase name="adds" /><testcase name="subtracts" />`), "utf8");

    await expect(page.getByTestId("test-name").filter({ hasText: "subtracts" })).toBeVisible();
    await expect(page.getByTestId("test-name").filter({ hasText: "unrelated" })).toHaveCount(0);
  });

  test("a deliberate open retires a seed that was still waiting", async ({ page, makeServer }, testInfo) => {
    const waiting = testInfo.outputPath("stale-seed");
    const chosen = testInfo.outputPath("stale-picked");
    mkdirSync(waiting, { recursive: true });
    mkdirSync(chosen, { recursive: true });
    const awaited = join(waiting, "run.xml");
    const picked = join(chosen, "picked.xml");
    const suite = (name: string) => `<testsuites><testsuite name="s"><testcase name="${name}" /></testsuite></testsuites>`;
    writeFileSync(awaited, `<testsuites><testsuite name="s"><testcase name="fromSeed" />`, "utf8");
    writeFileSync(picked, suite("fromOpen"), "utf8");

    const s = await makeServer({ resultsFile: awaited, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-name").filter({ hasText: "fromSeed" })).toHaveCount(0);

    s.openFiles({ files: [picked] });
    await expect(page.getByTestId("test-name").filter({ hasText: "fromOpen" })).toBeVisible();

    // The report the seed was waiting for arrives late. It must not pull the
    // panel off what was asked for since -- and the panel is still following
    // that, which is what says the watchers saw both writes.
    writeFileSync(awaited, suite("fromSeed"), "utf8");
    writeFileSync(picked, suite("openAgain"), "utf8");

    await expect(page.getByTestId("test-name").filter({ hasText: "openAgain" })).toBeVisible();
    await expect(page.getByTestId("test-name").filter({ hasText: "fromSeed" })).toHaveCount(0);
  });

  test("a source whose format only shows past its head still follows the next run", async ({ page, makeServer }, testInfo) => {
    // Scans judge a file by its opening, but a named source is read whole -- so
    // one that opens with a long preamble still knows what format it is.
    const dir = testInfo.outputPath("late-format");
    mkdirSync(dir, { recursive: true });
    const suite = (name: string) => `<testsuites><testsuite name="s"><testcase name="${name}" /></testsuite></testsuites>`;
    const file = join(dir, "first.xml");
    writeFileSync(file, `<!--${"pad ".repeat(3000)}-->${suite("first")}`, "utf8");

    const s = await makeServer({ resultsFile: file, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-name").filter({ hasText: "first" })).toBeVisible();

    writeFileSync(join(dir, "second.xml"), suite("second"), "utf8");

    await expect(page.getByTestId("test-name").filter({ hasText: "second" })).toBeVisible();
  });

  test("prefers a complete report over a newer one caught mid-write, then follows it", async ({ page, makeServer }, testInfo) => {
    const dir = testInfo.outputPath("partial-newest");
    mkdirSync(dir, { recursive: true });
    const done = join(dir, "old.xml");
    const fresh = join(dir, "new.xml");
    const suite = (cases: string) => `<testsuites><testsuite name="s">${cases}</testsuite></testsuites>`;
    writeFileSync(done, suite(`<testcase name="complete" />`), "utf8");
    // Newer, recognizable from its head, and cut off mid-document.
    writeFileSync(fresh, `<testsuites><testsuite name="s"><testcase name="partial" />`, "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(done, old, old);

    const s = await makeServer({ resultsDir: dir, watch: true });
    await openCanvas(page, s);
    // The newest candidate does not parse, so the finished run behind it is
    // what the panel shows.
    await expect(page.getByTestId("test-name").filter({ hasText: "complete" })).toBeVisible();

    writeFileSync(fresh, suite(`<testcase name="partial" />`), "utf8");

    // And once it is whole, the folder's newest report takes over as usual.
    await expect(page.getByTestId("test-name").filter({ hasText: "partial" })).toBeVisible();
  });

  test("adopts a requested report that only becomes readable after the panel opened", async ({ page, makeServer }, testInfo) => {
    const dir = testInfo.outputPath("awaited-dir");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "run.xml");
    writeFileSync(file, `<testsuites><testsuite name="s"><testcase name="adds" />`, "utf8");

    // Nothing in the folder parses, so nothing is seeded -- but the folder the
    // caller named is watched all the same.
    const s = await makeServer({ resultsDir: dir, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-name").filter({ hasText: "adds" })).toHaveCount(0);

    writeFileSync(file, `<testsuites><testsuite name="s"><testcase name="adds" /></testsuite></testsuites>`, "utf8");

    await expect(page.getByTestId("test-name").filter({ hasText: "adds" })).toBeVisible();
  });

  test("a directory source follows its newest readable report, whatever format that is", async ({ page, makeServer }, testInfo) => {
    // The folder is what was asked for, so a runner that starts writing its
    // results differently is still the same run, not a different one.
    const dir = testInfo.outputPath("dir-any-format");
    mkdirSync(dir, { recursive: true });
    const junit = join(dir, "old.xml");
    const ctrf = join(dir, "new.json");
    writeFileSync(junit, `<testsuites><testsuite name="s"><testcase name="fromJUnit" /></testsuite></testsuites>`, "utf8");
    // Newer, recognizable as CTRF, and cut off mid-document.
    writeFileSync(ctrf, `{"reportFormat":"CTRF","results":{"tool":{"name":"jest"},"tests":[{"name":"fromCTRF"`, "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(junit, old, old);

    const s = await makeServer({ resultsDir: dir, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-name").filter({ hasText: "fromJUnit" })).toBeVisible();

    writeFileSync(ctrf, `{"reportFormat":"CTRF","results":{"tool":{"name":"jest"},"tests":[{"name":"fromCTRF","status":"passed"}]}}`, "utf8");

    await expect(page.getByTestId("test-name").filter({ hasText: "fromCTRF" })).toBeVisible();
    await expect(page.getByTestId("test-name").filter({ hasText: "fromJUnit" })).toHaveCount(0);
  });

  test("watches a results directory that does not exist yet", async ({ page, makeServer }, testInfo) => {
    // `dotnet test` creates TestResults/ on its first run, so the folder the
    // agent names may well not be there when the panel opens.
    const dir = join(testInfo.outputPath("absent"), "TestResults");

    const s = await makeServer({ resultsDir: dir, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-name").filter({ hasText: "adds" })).toHaveCount(0);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.xml"), `<testsuites><testsuite name="s"><testcase name="adds" /></testsuite></testsuites>`, "utf8");

    await expect(page.getByTestId("test-name").filter({ hasText: "adds" })).toBeVisible();
  });

  test("recovers when the watched directory is deleted and recreated", async ({ page, makeServer }, testInfo) => {
    const dir = join(testInfo.outputPath("recreated"), "TestResults");
    mkdirSync(dir, { recursive: true });
    const suite = (name: string) => `<testsuites><testsuite name="s"><testcase name="${name}" /></testsuite></testsuites>`;
    writeFileSync(join(dir, "run.xml"), suite("before"), "utf8");

    const s = await makeServer({ resultsDir: dir, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-name").filter({ hasText: "before" })).toBeVisible();

    // The watcher is still attached to the directory that was removed, and no
    // event will ever arrive from the new one.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.xml"), suite("after"), "utf8");

    await expect(page.getByTestId("test-name").filter({ hasText: "after" })).toBeVisible();
  });

  test("does not seed a merge when one of the requested reports cannot be read, and takes it when it lands", async ({ page, makeServer }, testInfo) => {
    // A seed has no receipt to hand back, so a partial merge would show fewer
    // tests than were asked for with nothing on screen to say so.
    const dir = testInfo.outputPath("partial-seed");
    mkdirSync(dir, { recursive: true });
    const good = join(dir, "good.xml");
    const broken = join(dir, "broken.xml");
    const suite = (cases: string) => `<testsuites><testsuite name="s">${cases}</testsuite></testsuites>`;
    writeFileSync(good, suite(`<testcase name="adds" />`), "utf8");
    writeFileSync(broken, `<testsuites><testsuite name="s"><testcase name="subtracts"`, "utf8");

    const s = await makeServer({ name: "Solution", resultsFiles: [good, broken], watch: true });
    await openCanvas(page, s);

    // The readable half must not stand in for the run that was asked for. (An
    // unseeded panel falls back to whatever local report exists, as it always
    // has -- what matters is that it is not this half-loaded merge.)
    await expect(page.getByTestId("group-counts")).toHaveCount(0);
    await expect(page.getByTestId("test-name").filter({ hasText: "adds" })).toHaveCount(0);

    // The missing half was a report still being written, so the merge the
    // caller asked for arrives without reopening the panel.
    writeFileSync(broken, suite(`<testcase name="subtracts" />`), "utf8");

    await expect(page.getByTestId("group-counts")).toHaveText("2 files \u00B7 2 tests");
    await expect(page.getByTestId("test-name").filter({ hasText: "adds" })).toBeVisible();
  });

  test("opens an Allure folder named by several of its own result files", async ({ page, makeServer }, testInfo) => {
    // Those paths are one run, so the second is redundant rather than missing:
    // an all-or-nothing seed must not read it as a merge it could not complete.
    const dir = testInfo.outputPath("allure-duplicates");
    mkdirSync(dir, { recursive: true });
    const first = join(dir, "aaa-result.json");
    const second = join(dir, "bbb-result.json");
    writeFileSync(first, `{"uuid":"aaa","name":"adds","status":"passed"}`, "utf8");
    writeFileSync(second, `{"uuid":"bbb","name":"subtracts","status":"failed"}`, "utf8");

    const s = await makeServer({ name: "Allure", resultsFiles: [first, second], watch: false });
    await openCanvas(page, s);

    await expect(page.getByTestId("test-row")).toHaveCount(2);
    await expect(page.getByTestId("test-name").filter({ hasText: "subtracts" })).toBeVisible();
  });
});
