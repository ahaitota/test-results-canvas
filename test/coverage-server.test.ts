// Server-level coverage tests: how coverage state follows the results file it
// belongs to. These start a real server on an ephemeral port, because the
// behaviour under test lives in the wiring, not in any one pure function.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createResultsServer } from "../src/server.js";

const TRX = `<?xml version="1.0" encoding="utf-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results><UnitTestResult testName="adds" outcome="Passed" duration="00:00:00.01" /></Results>
</TestRun>`;

const COBERTURA = `<?xml version="1.0"?>
<coverage line-rate="0.5">
  <sources><source>SRC</source></sources>
  <packages><package name="p"><classes>
    <class name="Calc" filename="src/calc.ts"><lines>
      <line number="1" hits="1" /><line number="2" hits="0" />
    </lines></class>
  </classes></package></packages>
</coverage>`;

// Two runs: one with a coverage report sitting beside it, one with none
// anywhere discovery can reach.
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cov-server-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "calc.ts"), "export const a = 1;\nexport const b = 2;\n");

  mkdirSync(join(root, "with", "run"), { recursive: true });
  writeFileSync(join(root, "with", "run", "run.trx"), TRX);
  writeFileSync(join(root, "with", "run", "coverage.cobertura.xml"), COBERTURA.replace("SRC", root));

  mkdirSync(join(root, "without", "run"), { recursive: true });
  writeFileSync(join(root, "without", "run", "run.trx"), TRX);
  return root;
}

test("switching to a run without coverage clears the previous run's coverage", async () => {
  const root = makeFixture();
  const handle = await createResultsServer({
    port: 0,
    watch: false,
    // Scoped to the half of the fixture holding no report, so discovery has
    // nowhere to legitimately find one from the second run.
    projectRoot: join(root, "without"),
    gitExec: null,
    resultsFile: join(root, "with", "run", "run.trx"),
  });
  try {
    assert.ok(handle.getCoverage(), "the adjacent report must be discovered");

    handle.loadInput({ resultsFile: join(root, "without", "run", "run.trx") });
    assert.equal(handle.getCoverage(), null, "a run with no report must not show the previous one");
    assert.equal(handle.coveragePath(), null);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a report the agent named survives a reload that discovery would miss", async () => {
  const root = makeFixture();
  const explicit = join(root, "with", "run", "coverage.cobertura.xml");
  const handle = await createResultsServer({
    port: 0,
    watch: false,
    projectRoot: join(root, "without"),
    gitExec: null,
    resultsFile: join(root, "without", "run", "run.trx"),
    coverageFile: explicit,
  });
  try {
    assert.equal(handle.coveragePath(), explicit);

    // Re-seeding without naming the report again must not lose it: the agent
    // said where coverage lives, and discovery would find nothing here.
    handle.loadInput({ resultsFile: join(root, "without", "run", "run.trx") });
    assert.equal(handle.coveragePath(), explicit);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Review findings on the explicit-input contract ------------------------

test("naming a file that is not a coverage report says so", () => {
  const root = makeFixture();
  const notAReport = join(root, "README.md");
  writeFileSync(notAReport, "# not coverage\n");
  return (async () => {
    const handle = await createResultsServer({
      port: 0, watch: false, projectRoot: join(root, "without"), gitExec: null,
      resultsFile: join(root, "without", "run", "run.trx"),
      coverageFile: notAReport,
    });
    try {
      assert.equal(handle.getCoverage(), null);
      // Silence here would read as "the run collected no coverage", which is
      // wrong: the caller named a file and the file is unusable.
      assert.equal(handle.coverageError(), "not-coverage");
    } finally {
      await handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  })();
});

test("a report discovery merely guessed at stays silent when it is not coverage", () => {
  const root = makeFixture();
  return (async () => {
    const handle = await createResultsServer({
      port: 0, watch: false, projectRoot: join(root, "without"), gitExec: null,
      resultsFile: join(root, "without", "run", "run.trx"),
    });
    try {
      assert.equal(handle.getCoverage(), null);
      assert.equal(handle.coverageError(), null, "a miss during discovery is not an error");
    } finally {
      await handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  })();
});

test("an explicit report is not reused for a different run", () => {
  const root = makeFixture();
  const reportA = join(root, "with", "run", "coverage.cobertura.xml");
  return (async () => {
    const handle = await createResultsServer({
      port: 0, watch: false, projectRoot: join(root, "without"), gitExec: null,
      resultsFile: join(root, "with", "run", "run.trx"),
      coverageFile: reportA,
    });
    try {
      assert.equal(handle.coveragePath(), reportA);

      // Run B has no coverage. A belongs to run A, so it must not follow.
      handle.loadInput({ resultsFile: join(root, "without", "run", "run.trx") });
      assert.equal(handle.getCoverage(), null, "run A's report must not describe run B");
      assert.equal(handle.coveragePath(), null);
    } finally {
      await handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  })();
});

test("a new run naming a missing report keeps the failure instead of restoring the old one", () => {
  const root = makeFixture();
  const reportA = join(root, "with", "run", "coverage.cobertura.xml");
  return (async () => {
    const handle = await createResultsServer({
      port: 0, watch: false, projectRoot: join(root, "without"), gitExec: null,
      resultsFile: join(root, "with", "run", "run.trx"),
      coverageFile: reportA,
    });
    try {
      assert.equal(handle.coveragePath(), reportA);

      handle.loadInput({
        resultsFile: join(root, "without", "run", "run.trx"),
        coverageFile: join(root, "without", "gone.cobertura.xml"),
      });
      assert.equal(handle.getCoverage(), null, "the replacement is missing, so nothing is known");
      assert.equal(handle.coverageError(), "missing", "and the reason must survive");
    } finally {
      await handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  })();
});

// --- Review findings on the coverage watcher -------------------------------

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Results and coverage in separate folders, which is the normal layout and
// keeps the two watchers from reacting to each other's files.
function makeWatchFixture(): string {
  // realpath.native matters here: on Windows mkdtemp hands back the 8.3 short
  // form (C:\Users\T-AHAI~1\...), and fs.watch compares event paths against
  // the watched directory literally, which aborts the process on a mismatch.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cov-watch-")));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "calc.ts"), "export const a = 1;\nexport const b = 2;\n");
  mkdirSync(join(root, "a", "run"), { recursive: true });
  writeFileSync(join(root, "a", "run", "run.trx"), TRX);
  mkdirSync(join(root, "a-cov"));
  writeFileSync(join(root, "a-cov", "coverage.cobertura.xml"), COBERTURA.replace("SRC", root));
  // Deep enough that discovery from here cannot reach a-cov.
  mkdirSync(join(root, "b", "deep", "run"), { recursive: true });
  writeFileSync(join(root, "b", "deep", "run", "run.trx"), TRX);
  return root;
}

test("a watched report that goes bad clears the panel and says why, then recovers", async () => {
  const root = makeWatchFixture();
  const report = join(root, "a-cov", "coverage.cobertura.xml");
  const handle = await createResultsServer({
    port: 0, watch: true, projectRoot: join(root, "b"), gitExec: null,
    resultsFile: join(root, "a", "run", "run.trx"),
    coverageFile: report,
  });
  try {
    assert.ok(handle.getCoverage(), "the named report loads");

    // A re-run that writes something unusable must not leave last run's
    // numbers on screen looking current.
    writeFileSync(report, "this is not a coverage report\n");
    await settle(900);
    assert.equal(handle.getCoverage(), null, "stale numbers must not survive a bad rewrite");
    assert.equal(handle.coverageError(), "not-coverage");

    // The path stays watched, so finishing the write recovers it.
    writeFileSync(report, COBERTURA.replace("SRC", root));
    await settle(900);
    assert.ok(handle.getCoverage(), "the same path must recover once it is valid again");
    assert.equal(handle.coverageError(), null);

    rmSync(report);
    await settle(900);
    assert.equal(handle.getCoverage(), null);
    assert.equal(handle.coverageError(), "missing");
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Review findings on replacing an explicit report ------------------------

test("naming a report that cannot be read replaces the one on screen", () => {
  const root = makeFixture();
  const reportA = join(root, "with", "run", "coverage.cobertura.xml");
  const gone = join(root, "with", "run", "gone.cobertura.xml");
  return (async () => {
    const handle = await createResultsServer({
      port: 0, watch: false, projectRoot: join(root, "without"), gitExec: null,
      resultsFile: join(root, "with", "run", "run.trx"),
      coverageFile: reportA,
    });
    try {
      assert.ok(handle.getCoverage());

      // Naming coverage without naming a run: nothing re-attaches coverage to
      // a results file here, so only the pointer itself can clear the panel.
      handle.loadInput({ coverageFile: gone });
      assert.equal(handle.getCoverage(), null, "the old report is not an answer to this request");
      assert.equal(handle.coveragePath(), null);
      // With coverage still on screen the client renders the report, not the
      // empty state, so the reason would never reach the user.
      assert.equal(handle.coverageError(), "missing");

      // Same again through the direct call, which skips seeding entirely.
      handle.loadCoverage(reportA);
      assert.ok(handle.getCoverage(), "a good path loads again");
      handle.loadCoverage(gone);
      assert.equal(handle.getCoverage(), null);
      assert.equal(handle.coverageError(), "missing");
    } finally {
      await handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  })();
});

test("a named report that does not exist yet is picked up when it appears", async () => {
  const root = makeWatchFixture();
  const pending = join(root, "a-cov", "later.cobertura.xml");
  const handle = await createResultsServer({
    port: 0, watch: true, projectRoot: join(root, "b"), gitExec: null,
    resultsFile: join(root, "a", "run", "run.trx"),
    coverageFile: pending,
  });
  try {
    assert.equal(handle.getCoverage(), null, "named but not written yet");
    assert.equal(handle.coverageError(), "missing");

    // The run finishes and writes the file the caller named.
    writeFileSync(pending, COBERTURA.replace("SRC", root));
    await settle(900);
    assert.ok(handle.getCoverage(), "the named path must load once it exists");
    assert.equal(handle.coveragePath(), pending);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("waiting for a named report does not settle for a different one", async () => {
  const root = makeWatchFixture();
  const pending = join(root, "a-cov", "later.cobertura.xml");
  const handle = await createResultsServer({
    port: 0, watch: true, projectRoot: join(root, "b"), gitExec: null,
    resultsFile: join(root, "a", "run", "run.trx"),
    coverageFile: pending,
  });
  try {
    assert.equal(handle.getCoverage(), null);

    // A different report lands in the watched folder. The caller asked for a
    // specific file, so this one is somebody else's.
    writeFileSync(join(root, "a-cov", "other.cobertura.xml"), COBERTURA.replace("SRC", root));
    await settle(900);
    assert.equal(handle.getCoverage(), null, "only the named path may satisfy a named request");
    assert.equal(handle.coverageError(), "missing");
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a named report waits for a folder that the test run has not created yet", async () => {
  const root = makeWatchFixture();
  // The folder itself does not exist: naming coverage/lcov.info before the run
  // writes it is the ordinary case, not an edge case.
  const pending = join(root, "a-cov", "nested", "later.cobertura.xml");
  const handle = await createResultsServer({
    port: 0, watch: true, projectRoot: join(root, "b"), gitExec: null,
    resultsFile: join(root, "a", "run", "run.trx"),
    coverageFile: pending,
  });
  try {
    assert.equal(handle.getCoverage(), null);

    mkdirSync(join(root, "a-cov", "nested"));
    await settle(1400);
    writeFileSync(pending, COBERTURA.replace("SRC", root));
    await settle(900);
    assert.ok(handle.getCoverage(), "the watch must follow the folder down as it appears");
    assert.equal(handle.coveragePath(), pending);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a named folder holding no report clears the panel and waits for one", async () => {
  const root = makeWatchFixture();
  const empty = join(root, "empty-cov");
  mkdirSync(empty);
  const handle = await createResultsServer({
    port: 0, watch: true, projectRoot: join(root, "b"), gitExec: null,
    resultsFile: join(root, "a", "run", "run.trx"),
    coverageFile: join(root, "a-cov", "coverage.cobertura.xml"),
  });
  try {
    assert.ok(handle.getCoverage(), "the named file loads first");

    // Pointing at a different folder is a new request; the old report is not
    // an answer to it.
    handle.loadInput({ coverageDir: empty });
    assert.equal(handle.getCoverage(), null);
    assert.equal(handle.coverageError(), "missing");

    // The run finishes and drops a report in the folder that was named.
    writeFileSync(join(empty, "coverage.cobertura.xml"), COBERTURA.replace("SRC", root));
    await settle(900);
    assert.ok(handle.getCoverage(), "a report appearing in the named folder is picked up");
    assert.equal(handle.coveragePath(), join(empty, "coverage.cobertura.xml"));
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a named folder that does not exist yet is waited for and picked up", async () => {
  const root = makeWatchFixture();
  // Neither the folder nor the report exists when the panel opens. This is the
  // ordinary case for a run that is still going. Nested deliberately: a watcher
  // left on the nearest existing folder cannot see three levels down, so only
  // moving it as the path appears can find the report.
  const later = join(root, "later-cov", "inner", "deep");
  const handle = await createResultsServer({
    port: 0, watch: true, projectRoot: join(root, "b"), gitExec: null,
    resultsFile: join(root, "a", "run", "run.trx"),
    coverageDir: later,
  });
  try {
    assert.equal(handle.getCoverage(), null);
    assert.equal(handle.coverageError(), "missing");

    // The folder appears first, carrying no coverage extension in its name,
    // and the watcher standing on the ancestor has to move down into it. The
    // gap is well clear of the 400 ms debounce, so the move must have happened
    // before the report is written.
    mkdirSync(later, { recursive: true });
    await settle(1400);
    writeFileSync(join(later, "coverage.cobertura.xml"), COBERTURA.replace("SRC", root));
    await settle(900);
    assert.ok(handle.getCoverage(), "the report must load once the named folder holds one");
    assert.equal(handle.coveragePath(), join(later, "coverage.cobertura.xml"));
    assert.equal(handle.coverageError(), null);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a named folder created together with its report still loads", async () => {
  const root = makeWatchFixture();
  const later = join(root, "quick-cov");
  const handle = await createResultsServer({
    port: 0, watch: true, projectRoot: join(root, "b"), gitExec: null,
    resultsFile: join(root, "a", "run", "run.trx"),
    coverageDir: later,
  });
  try {
    assert.equal(handle.getCoverage(), null);

    // No pause between the two: the folder event and the report arrive inside
    // one debounce window, so moving the watcher down cannot be what finds it.
    mkdirSync(later);
    writeFileSync(join(later, "coverage.cobertura.xml"), COBERTURA.replace("SRC", root));
    await settle(900);
    assert.ok(handle.getCoverage(), "the folder is re-read on the event that created it");
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// Reads the SSE stream the panel actually consumes. The handle accessors above
// can be right while clients are told nothing, which is how a stale report
// stays on screen, so recovery is asserted here on the wire.
async function coverageEvents(url: string, signal: AbortSignal): Promise<string[]> {
  const seen: string[] = [];
  const res = await fetch(new URL("/events", url), { signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line || frame.startsWith("event:")) continue;
        const state = JSON.parse(line.slice(6));
        seen.push(state.coverage ? "coverage" : (state.coverageError ?? "empty"));
      }
    }
  } catch { /* aborted */ }
  return seen;
}

test("clients are told when a named report finally arrives", async () => {
  const root = makeWatchFixture();
  const later = join(root, "sse-cov");
  const handle = await createResultsServer({
    port: 0, watch: true, projectRoot: join(root, "b"), gitExec: null,
    resultsFile: join(root, "a", "run", "run.trx"),
    coverageDir: later,
  });
  const abort = new AbortController();
  const events = coverageEvents(handle.url, abort.signal);
  try {
    await settle(200);
    mkdirSync(later);
    writeFileSync(join(later, "coverage.cobertura.xml"), COBERTURA.replace("SRC", root));
    await settle(900);

    abort.abort();
    const seen = await events;
    assert.equal(seen[0], "missing", "the first frame reports nothing is there yet");
    assert.ok(seen.includes("coverage"), `recovery must reach clients, saw: ${seen.join(" -> ")}`);
  } finally {
    abort.abort();
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a re-run writing its report under a new name is picked up", async () => {
  const root = makeWatchFixture();
  const first = join(root, "a-cov", "coverage.cobertura.xml");
  // No coverageFile: discovery finds the report on its own, which is the
  // normal path when the agent did not name one.
  const handle = await createResultsServer({
    port: 0, watch: true, projectRoot: root, gitExec: null,
    resultsFile: join(root, "a", "run", "run.trx"),
  });
  try {
    assert.equal(handle.coveragePath(), first, "discovery finds the report beside the run");

    // Collectors stamp the run into the name (coverlet writes a fresh GUID
    // folder every time), so the next run is a different path in the same
    // place. Following the folder is what makes that arrive.
    rmSync(first);
    writeFileSync(join(root, "a-cov", "run-2.cobertura.xml"), COBERTURA.replace("SRC", root));
    await settle(900);
    assert.equal(handle.coveragePath(), join(root, "a-cov", "run-2.cobertura.xml"));
    assert.ok(handle.getCoverage(), "the re-run's report must load");
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a debounced watcher callback cannot resurrect the report of a retired run", async () => {
  const root = makeWatchFixture();
  const report = join(root, "a-cov", "coverage.cobertura.xml");
  const handle = await createResultsServer({
    port: 0, watch: true, projectRoot: join(root, "b"), gitExec: null,
    resultsFile: join(root, "a", "run", "run.trx"),
    coverageFile: report,
  });
  try {
    assert.ok(handle.getCoverage());

    // Touch the report and let the watcher arm its 400 ms debounce, then
    // switch runs inside that window. The pending callback belongs to a run
    // nobody is looking at any more.
    writeFileSync(report, COBERTURA.replace("SRC", root).replace('hits="0"', 'hits="3"'));
    await settle(120);
    handle.loadInput({ resultsFile: join(root, "b", "deep", "run", "run.trx") });
    assert.equal(handle.getCoverage(), null, "switching runs drops the old report immediately");

    await settle(900);
    assert.equal(handle.getCoverage(), null, "and the retired callback must not bring it back");
    assert.equal(handle.coveragePath(), null);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
