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

    writeFileSync(ctrf, `{"reportFormat":"CTRF","results":{"tool":{"name":"jest"},"summary":{"tests":1,"passed":1,"failed":0,"skipped":0,"pending":0,"other":0},"tests":[{"name":"fromCTRF","status":"passed"}]}}`, "utf8");

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

  test("a directory source caught mid-rewrite keeps its run, not an older green one", async ({ page, makeServer }, testInfo) => {
    // The folder's newest report is the failing one on screen. While the runner
    // rewrites it, falling back down the folder would replace a failing run
    // with the passing run it superseded -- the worst thing the panel can show.
    const dir = testInfo.outputPath("mid-rewrite");
    mkdirSync(dir, { recursive: true });
    const older = join(dir, "old.xml");
    const current = join(dir, "current.xml");
    writeFileSync(older, `<testsuites><testsuite name="s"><testcase name="oldPass" /></testsuite></testsuites>`, "utf8");
    writeFileSync(current, `<testsuites><testsuite name="s"><testcase name="broke"><failure message="boom" /></testcase></testsuite></testsuites>`, "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(older, old, old);

    const s = await makeServer({ resultsDir: dir, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-name").filter({ hasText: "broke" })).toBeVisible();

    // Recognizable as a report, and cut off mid-document.
    writeFileSync(current, `<testsuites><testsuite name="s"><testcase name="broke"`, "utf8");
    // Long enough for the debounce and a poll to have come and gone.
    await page.waitForTimeout(1500);

    await expect(page.getByTestId("test-name").filter({ hasText: "oldPass" })).toHaveCount(0);
    await expect(page.getByTestId("test-name").filter({ hasText: "broke" })).toBeVisible();
  });

  test("a directory source does not fall back to a run older than the one it shows", async ({ page, makeServer }, testInfo) => {
    // The failing report is deleted before its replacement lands. What is left
    // in the folder finished BEFORE it, so taking it would answer a run being
    // replaced with the passing run it already superseded.
    const dir = testInfo.outputPath("no-going-back");
    mkdirSync(dir, { recursive: true });
    const older = join(dir, "old.xml");
    const current = join(dir, "current.xml");
    writeFileSync(older, `<testsuites><testsuite name="s"><testcase name="oldPass" /></testsuite></testsuites>`, "utf8");
    writeFileSync(current, `<testsuites><testsuite name="s"><testcase name="broke"><failure message="boom" /></testcase></testsuite></testsuites>`, "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(older, old, old);

    const s = await makeServer({ resultsDir: dir, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-name").filter({ hasText: "broke" })).toBeVisible();

    rmSync(current);
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("test-name").filter({ hasText: "oldPass" })).toHaveCount(0);

    // The replacement does land eventually, and is newer, so it is taken.
    writeFileSync(join(dir, "next.xml"), `<testsuites><testsuite name="s"><testcase name="fromNextRun" /></testsuite></testsuites>`, "utf8");
    await expect(page.getByTestId("test-name").filter({ hasText: "fromNextRun" })).toBeVisible();
  });

  test("merged sources re-anchor when the replacements arrive after the deletion", async ({ page, makeServer }, testInfo) => {
    const dir = testInfo.outputPath("staggered");
    mkdirSync(dir, { recursive: true });
    const suite = (name: string) => `<testsuites><testsuite name="s"><testcase name="${name}" /></testsuite></testsuites>`;
    const billing = join(dir, "billing-1.xml");
    const shipping = join(dir, "shipping-1.xml");
    writeFileSync(billing, suite("billingOld"), "utf8");
    writeFileSync(shipping, suite("shippingOld"), "utf8");

    const s = await makeServer({ name: "Solution", resultsFiles: [billing, shipping], watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-row")).toHaveCount(2);

    // The deletion is seen on its own, so the batch that brings the
    // replacements names neither of the files the sources are anchored on.
    rmSync(billing);
    rmSync(shipping);
    await page.waitForTimeout(1200);
    writeFileSync(join(dir, "billing-2.xml"), suite("billingNew"), "utf8");
    writeFileSync(join(dir, "shipping-2.xml"), suite("shippingNew"), "utf8");

    await expect(page.getByTestId("test-name").filter({ hasText: "billingNew" })).toBeVisible();
    await expect(page.getByTestId("test-name").filter({ hasText: "shippingNew" })).toBeVisible();
  });

  test("a merge is not restored, or recorded, one member short", async ({ page, makeServer }, testInfo) => {
    // Three members, because a merge that decays to two is still a named merge:
    // publishing it would also record those two AS the group, and the third
    // member would be forgotten even after it came back.
    const dir = testInfo.outputPath("restore-partial");
    mkdirSync(dir, { recursive: true });
    const suite = (name: string) => `<testsuites><testsuite name="s"><testcase name="${name}" /></testsuite></testsuites>`;
    const a = join(dir, "a.xml");
    const b = join(dir, "b.xml");
    const c = join(dir, "c.xml");
    writeFileSync(a, suite("fromA"), "utf8");
    writeFileSync(b, suite("fromB"), "utf8");
    writeFileSync(c, suite("fromC"), "utf8");

    const s = await makeServer({ name: "Solution", resultsFiles: [a, b, c], watch: false });
    await openCanvas(page, s);
    const picker = page.getByTestId("file-select");
    await picker.selectOption("a.xml");
    await expect(page.getByTestId("test-row")).toHaveCount(1);

    // C is mid-write when the merge is asked for again.
    writeFileSync(c, `<testsuites><testsuite name="s"><testcase name="fromC"`, "utf8");
    await picker.selectOption("Solution");

    // Two thirds of a merge must not be published as the merge.
    await expect(page.getByTestId("test-name").filter({ hasText: "fromA" })).toBeVisible();
    await expect(page.getByTestId("test-row")).toHaveCount(1);

    // Once C is whole again the merge comes back in full, so nothing was lost.
    writeFileSync(c, suite("fromC"), "utf8");
    await picker.selectOption("Solution");
    await expect(page.getByTestId("group-counts")).toHaveText("3 files \u00B7 3 tests");
  });

  test("a merge whose deleted member has no replacement keeps that member", async ({ page, makeServer }, testInfo) => {
    // Three members, so losing one still leaves a plural merge -- which is what
    // makes this worse than the two-member case: the reduced set is a valid
    // merge, so publishing it also RECORDS it, and the third member is gone for
    // good even after its report comes back.
    const dir = testInfo.outputPath("restore-deleted");
    mkdirSync(dir, { recursive: true });
    const suite = (name: string) => `<testsuites><testsuite name="s"><testcase name="${name}" /></testsuite></testsuites>`;
    const a = join(dir, "a.xml");
    const b = join(dir, "b.xml");
    const c = join(dir, "c.xml");
    writeFileSync(a, suite("fromA"), "utf8");
    writeFileSync(b, suite("fromB"), "utf8");
    writeFileSync(c, suite("fromC"), "utf8");

    const s = await makeServer({ name: "Solution", resultsFiles: [a, b, c], watch: false });
    await openCanvas(page, s);
    const picker = page.getByTestId("file-select");
    await picker.selectOption("a.xml");
    await expect(page.getByTestId("test-row")).toHaveCount(1);

    rmSync(c);
    await picker.selectOption("Solution");

    // Two thirds of a merge is not the merge, however readable those two are.
    await expect(page.getByTestId("test-name").filter({ hasText: "fromA" })).toBeVisible();
    await expect(page.getByTestId("test-row")).toHaveCount(1);

    // And C was not written out of the group, so its report returning brings
    // the whole merge back.
    writeFileSync(c, suite("fromC"), "utf8");
    await picker.selectOption("Solution");
    await expect(page.getByTestId("group-counts")).toHaveText("3 files \u00B7 3 tests");
  });

  test("picking a file caught mid-write leaves the run that is on screen", async ({ page, makeServer }, testInfo) => {
    const dir = testInfo.outputPath("pick-partial");
    mkdirSync(dir, { recursive: true });
    const suite = (name: string) => `<testsuites><testsuite name="s"><testcase name="${name}" /></testsuite></testsuites>`;
    const a = join(dir, "a.xml");
    const b = join(dir, "b.xml");
    writeFileSync(a, suite("fromA"), "utf8");
    writeFileSync(b, suite("fromB"), "utf8");

    const s = await makeServer({ name: "Solution", resultsFiles: [a, b], watch: false });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-row")).toHaveCount(2);

    writeFileSync(b, `<testsuites><testsuite name="s"><testcase name="fromB"`, "utf8");
    await page.getByTestId("file-select").selectOption("b.xml");

    // The merge is still what is loaded, and the picker still says so.
    await expect(page.getByTestId("test-row")).toHaveCount(2);
    await expect(page.getByTestId("file-select")).toHaveValue("Solution");
  });

  test("opens an Allure folder whose results only identify themselves late", async ({ page, makeServer }, testInfo) => {
    // Same run, but nothing in the first 8 KiB of either file says so. Grouping
    // has to agree with parsing, or each file is taken for a source of its own
    // and the pair of them expands to every row twice over.
    const dir = testInfo.outputPath("allure-late");
    mkdirSync(dir, { recursive: true });
    const pad = "x".repeat(9000);
    const first = join(dir, "aaa-result.json");
    const second = join(dir, "bbb-result.json");
    writeFileSync(first, `{"description":"${pad}","uuid":"aaa","name":"adds","status":"passed"}`, "utf8");
    writeFileSync(second, `{"description":"${pad}","uuid":"bbb","name":"subtracts","status":"failed"}`, "utf8");

    const s = await makeServer({ name: "Allure", resultsFiles: [first, second], watch: false });
    await openCanvas(page, s);

    await expect(page.getByTestId("test-row")).toHaveCount(2);
  });

  test("a merge whose members rotate can still be restored from a drilled member", async ({ page, makeServer }, testInfo) => {
    // Drilled into one member, so the group is not what is on screen -- but its
    // members are still rotating underneath, and the saved definition has to
    // follow them or there is no way back to the merge.
    const dir = testInfo.outputPath("rotate-drilled");
    mkdirSync(dir, { recursive: true });
    const suite = (name: string) => `<testsuites><testsuite name="s"><testcase name="${name}" /></testsuite></testsuites>`;
    const a = join(dir, "a-1.xml");
    const b = join(dir, "b-1.xml");
    writeFileSync(a, suite("aOld"), "utf8");
    writeFileSync(b, suite("bOld"), "utf8");

    const s = await makeServer({ name: "Solution", resultsFiles: [a, b], watch: true });
    await openCanvas(page, s);
    const picker = page.getByTestId("file-select");
    await picker.selectOption("a-1.xml");
    await expect(page.getByTestId("test-name").filter({ hasText: "aOld" })).toBeVisible();

    rmSync(a);
    rmSync(b);
    writeFileSync(join(dir, "a-2.xml"), suite("aNew"), "utf8");
    writeFileSync(join(dir, "b-2.xml"), suite("bNew"), "utf8");

    // The drilled view follows the folder to one of the new runs -- which one
    // is whichever is newest, and either is a report from this run rather than
    // the deleted one it was showing.
    await expect(page.getByTestId("test-name").filter({ hasText: "Old" })).toHaveCount(0);
    await expect(page.getByTestId("test-row")).toHaveCount(1);

    // And the merge it came from is still there to go back to, with both
    // members re-derived from the names they now go under.
    await picker.selectOption("Solution");
    await expect(page.getByTestId("group-counts")).toHaveText("2 files \u00B7 2 tests");
    await expect(page.getByTestId("test-name").filter({ hasText: "aNew" })).toBeVisible();
    await expect(page.getByTestId("test-name").filter({ hasText: "bNew" })).toBeVisible();
  });

  test("a missing member is not restored from an older unrelated report", async ({ page, makeServer }, testInfo) => {
    // Re-deriving a member from its folder is what carries a merge through a
    // re-run that renames things -- but an old report that happens to be lying
    // beside it is not that member under a new name.
    const dir = testInfo.outputPath("restore-unrelated");
    mkdirSync(dir, { recursive: true });
    const suite = (name: string) => `<testsuites><testsuite name="s"><testcase name="${name}" /></testsuite></testsuites>`;
    const a = join(dir, "a.xml");
    const b = join(dir, "b.xml");
    const unrelated = join(dir, "unrelated.xml");
    writeFileSync(a, suite("fromA"), "utf8");
    writeFileSync(b, suite("fromB"), "utf8");
    writeFileSync(unrelated, suite("unrelatedOldRun"), "utf8");
    const tenMinutesAgo = new Date(Date.now() - 600_000);
    utimesSync(unrelated, tenMinutesAgo, tenMinutesAgo);

    const s = await makeServer({ name: "Solution", resultsFiles: [a, b], watch: false });
    await openCanvas(page, s);
    const picker = page.getByTestId("file-select");
    await picker.selectOption("a.xml");
    await expect(page.getByTestId("test-row")).toHaveCount(1);

    rmSync(b);
    await picker.selectOption("Solution");

    // B has no replacement, so the merge is a member short and is not published
    // -- rather than published with a run that was never part of it.
    await expect(page.getByTestId("test-name").filter({ hasText: "unrelatedOldRun" })).toHaveCount(0);
    await expect(page.getByTestId("test-name").filter({ hasText: "fromA" })).toBeVisible();
    await expect(page.getByTestId("test-row")).toHaveCount(1);

    // And nothing was recorded in B's place, so B coming back restores the merge.
    writeFileSync(b, suite("fromB"), "utf8");
    await picker.selectOption("Solution");
    await expect(page.getByTestId("group-counts")).toHaveText("2 files \u00B7 2 tests");
  });

  test("a drilled member does not follow another live member of its merge", async ({ page, makeServer }, testInfo) => {
    // Drilled into A with B still live: following the folder's newest report
    // would take A onto B's file, and a merge that names one file twice can
    // never be restored again.
    const dir = testInfo.outputPath("drill-sibling");
    mkdirSync(dir, { recursive: true });
    const suite = (name: string) => `<testsuites><testsuite name="s"><testcase name="${name}" /></testsuite></testsuites>`;
    const a = join(dir, "a.xml");
    const b = join(dir, "b.xml");
    writeFileSync(a, suite("fromA"), "utf8");
    writeFileSync(b, suite("fromB"), "utf8");

    const s = await makeServer({ name: "Solution", resultsFiles: [a, b], watch: true });
    await openCanvas(page, s);
    const picker = page.getByTestId("file-select");
    await picker.selectOption("a.xml");
    await expect(page.getByTestId("test-name").filter({ hasText: "fromA" })).toBeVisible();

    rmSync(a);
    await page.waitForTimeout(1200);
    writeFileSync(b, suite("fromBRerun"), "utf8");
    await page.waitForTimeout(1200);

    // B is somebody else's file: A stays on the run it was showing.
    await expect(page.getByTestId("test-name").filter({ hasText: "fromBRerun" })).toHaveCount(0);
    await expect(page.getByTestId("test-name").filter({ hasText: "fromA" })).toBeVisible();

    // So the merge still names two distinct files, and comes back once A does.
    writeFileSync(a, suite("fromARerun"), "utf8");
    await picker.selectOption("Solution");
    await expect(page.getByTestId("group-counts")).toHaveText("2 files \u00B7 2 tests");
    await expect(page.getByTestId("test-name").filter({ hasText: "fromARerun" })).toBeVisible();
    await expect(page.getByTestId("test-name").filter({ hasText: "fromBRerun" })).toBeVisible();
  });

  test("merged sources in one folder follow a re-run that renames every file", async ({ page, makeServer }, testInfo) => {
    // Two projects writing timestamped reports into one folder: the old pair is
    // gone, so both sources have to re-anchor -- and onto one file each, not
    // both onto the newest.
    const dir = testInfo.outputPath("merged-renamed");
    mkdirSync(dir, { recursive: true });
    const suite = (name: string) => `<testsuites><testsuite name="s"><testcase name="${name}" /></testsuite></testsuites>`;
    const billing = join(dir, "billing-1.xml");
    const shipping = join(dir, "shipping-1.xml");
    writeFileSync(billing, suite("billingOld"), "utf8");
    writeFileSync(shipping, suite("shippingOld"), "utf8");

    const s = await makeServer({ name: "Solution", resultsFiles: [billing, shipping], watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-row")).toHaveCount(2);

    rmSync(billing);
    rmSync(shipping);
    writeFileSync(join(dir, "billing-2.xml"), suite("billingNew"), "utf8");
    writeFileSync(join(dir, "shipping-2.xml"), suite("shippingNew"), "utf8");

    await expect(page.getByTestId("test-name").filter({ hasText: "billingNew" })).toBeVisible();
    await expect(page.getByTestId("test-name").filter({ hasText: "shippingNew" })).toBeVisible();
    await expect(page.getByTestId("test-row")).toHaveCount(2);

    // And the merge still names what it now holds: drilling into one member and
    // picking the group again must not restore it from the files that are gone.
    const picker = page.getByTestId("file-select");
    await picker.selectOption("shipping-2.xml");
    await expect(page.getByTestId("test-row")).toHaveCount(1);

    await picker.selectOption("Solution");
    await expect(page.getByTestId("group-counts")).toHaveText("2 files \u00B7 2 tests");
  });

  test("a folder whose newest report is still being written shows the finished one", async ({ page, makeServer }, testInfo) => {
    // The parsers reject an incomplete report, so the newest file in a folder
    // can be recognisable and still unreadable. Without trying the one behind
    // it the panel would open on nothing at all.
    const dir = testInfo.outputPath("mid-write-seed");
    mkdirSync(dir, { recursive: true });
    const done = join(dir, "old.xml");
    const fresh = join(dir, "new.xml");
    writeFileSync(done, `<testsuites><testsuite name="s"><testcase name="finished" /></testsuite></testsuites>`, "utf8");
    // Newer, recognisable from its head, and cut off mid-document.
    writeFileSync(fresh, `<testsuites><testsuite name="s"><testcase name="partial" />`, "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(done, old, old);

    const s = await makeServer({ resultsDir: dir, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-name").filter({ hasText: "finished" })).toBeVisible();

    // And once the newer one is whole, the folder moves on to it.
    writeFileSync(fresh, `<testsuites><testsuite name="s"><testcase name="partial" /></testsuite></testsuites>`, "utf8");
    await expect(page.getByTestId("test-name").filter({ hasText: "partial" })).toBeVisible();
  });

  test("a folder holding nothing readable yet recovers when a report lands", async ({ page, makeServer }, testInfo) => {
    // Nothing parses when the panel opens, so nothing is seeded -- but the
    // folder the caller named is watched all the same.
    const dir = testInfo.outputPath("awaited-seed");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "run.xml");
    writeFileSync(file, `<testsuites><testsuite name="s"><testcase name="adds" />`, "utf8");

    const s = await makeServer({ resultsDir: dir, watch: true });
    await openCanvas(page, s);
    await expect(page.getByTestId("test-name").filter({ hasText: "adds" })).toHaveCount(0);

    writeFileSync(file, `<testsuites><testsuite name="s"><testcase name="adds" /></testsuite></testsuites>`, "utf8");

    await expect(page.getByTestId("test-name").filter({ hasText: "adds" })).toBeVisible();
  });
});
