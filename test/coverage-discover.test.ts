// Unit tests for the on-disk half of the coverage feature: finding the report
// that belongs with a results file, mapping report paths back to real files,
// and the allow-list that stands in front of the /source route.
// Run with: node --test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { discoverCoverageFor, newestCoverageFileIn, pickBest } from "../src/coverage/discover.js";
import { findProjectRoot, resolveReportSources } from "../src/coverage/sources/resolve.js";
import { commonSuffixSegments, findByPath, normalizeSlashes, withinRoot } from "../src/coverage/sources/paths.js";
import { loadCoverageFile } from "../src/coverage/load.js";
import type { GitExec } from "../src/coverage/analysis/gitdiff.js";
import { readSourceView } from "../src/coverage/sources/view.js";
import type { SourceFileView } from "../src/coverage/model/payload.js";
import { suggestCoverageCommand } from "../src/coverage/suggest.js";
import { parseCobertura } from "../src/coverage/formats/cobertura.js";
import { parseLcov } from "../src/coverage/formats/lcov.js";

let root: string;

const CALC_SOURCE = [
  "export function add(a: number, b: number) {",
  "  return a + b;",
  "}",
  "export function sub(a: number, b: number) {",
  "  return a - b;",
  "}",
].join("\n");

// A project laid out the way `dotnet test` leaves one, so discovery is
// exercised against the real shape rather than a contrived one.
function coberturaFor(filename: string, lines: [number, number][]): string {
  const body = lines.map(([n, h]) => `<line number="${n}" hits="${h}" />`).join("");
  return `<?xml version="1.0"?><coverage><sources><source>${root}</source></sources>
    <packages><package><classes>
      <class name="Calc" filename="${filename}"><lines>${body}</lines></class>
    </classes></package></packages></coverage>`;
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "cov-test-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "TestResults", "abc-guid"), { recursive: true });
  mkdirSync(join(root, "coverage"), { recursive: true });
  // A root marker, so findProjectRoot stops here instead of walking into the
  // temp directory's ancestors.
  writeFileSync(join(root, "package.json"), '{"name":"fixture"}');
  writeFileSync(join(root, "src", "calc.ts"), CALC_SOURCE);
  writeFileSync(join(root, "TestResults", "run.trx"), "<TestRun/>");
  writeFileSync(
    join(root, "TestResults", "abc-guid", "coverage.cobertura.xml"),
    coberturaFor("src/calc.ts", [[2, 3], [5, 0], [6, 0]]),
  );
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("findProjectRoot stops at the folder carrying the project marker", () => {
  assert.equal(findProjectRoot(join(root, "src")), resolvePath(root));
});

test("findProjectRoot prefers the nearest marker over a stray one further up", () => {
  // A `package.json` sitting in a home directory must not become the project
  // root for every project beneath it -- that would point git and the source
  // index at the whole home folder.
  const outer = mkdtempSync(join(tmpdir(), "cov-outer-"));
  try {
    const inner = join(outer, "packages", "app");
    mkdirSync(join(inner, "src"), { recursive: true });
    writeFileSync(join(outer, "package.json"), "{}");
    writeFileSync(join(inner, "package.json"), "{}");
    assert.equal(findProjectRoot(join(inner, "src")), resolvePath(inner));
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("discoverCoverageFor finds the report the same run wrote", () => {
  const found = discoverCoverageFor(join(root, "TestResults", "run.trx"), root);
  assert.equal(found, resolvePath(root, "TestResults", "abc-guid", "coverage.cobertura.xml"));
});

test("discovery prefers the neighbouring report over a newer one further away", () => {
  // Proximity beats recency: a stale report elsewhere in the repo can easily be
  // newer than the correct sibling, and picking it would silently show numbers
  // from a different project.
  const distant = join(root, "coverage", "lcov.info");
  writeFileSync(distant, "SF:src/other.ts\nDA:1,1\nend_of_record\n");
  const future = new Date(Date.now() + 60_000);
  utimesSync(distant, future, future);

  const found = discoverCoverageFor(join(root, "TestResults", "run.trx"), root);
  assert.equal(found, resolvePath(root, "TestResults", "abc-guid", "coverage.cobertura.xml"));
  rmSync(distant);
});

test("discovery ignores a results file that is not a coverage report", () => {
  // TestResults/run.trx sits in the searched folder; mistaking it for coverage
  // would produce an empty but confident-looking panel.
  assert.equal(newestCoverageFileIn(join(root, "TestResults")), null);
});

test("discoverCoverageFor returns null when the project has no report", () => {
  const bare = mkdtempSync(join(tmpdir(), "cov-bare-"));
  try {
    writeFileSync(join(bare, "results.trx"), "<TestRun/>");
    assert.equal(discoverCoverageFor(join(bare, "results.trx"), bare), null);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("the last-resort walk skips coverage fixtures under a test folder", () => {
  // A repo's own e2e fixtures are not the run's output; attaching one showed
  // every changed file as "not measured".
  const repo = mkdtempSync(join(tmpdir(), "cov-fixture-"));
  try {
    mkdirSync(join(repo, "e2e", "fixtures", "coverage"), { recursive: true });
    writeFileSync(join(repo, "e2e", "fixtures", "coverage", "sample.cobertura.xml"), coberturaFor("Hostile.cs", [[1, 0]]));
    writeFileSync(join(repo, "results.trx"), "<TestRun/>");
    assert.equal(discoverCoverageFor(join(repo, "results.trx"), repo), null);

    // A real report still wins from the same walk.
    mkdirSync(join(repo, "src", "reports"), { recursive: true });
    const real = join(repo, "src", "reports", "coverage.cobertura.xml");
    writeFileSync(real, coberturaFor("Calc.cs", [[1, 1]]));
    assert.equal(discoverCoverageFor(join(repo, "results.trx"), repo), resolvePath(real));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("discoverCoverageFor finds a monorepo report inside packages/", () => {
  // A workspace's packages/ folder is source, not a package-manager cache.
  // Skipping it leaves a monorepo with no coverage at all.
  const mono = mkdtempSync(join(tmpdir(), "cov-mono-"));
  try {
    mkdirSync(join(mono, "packages", "app", "coverage"), { recursive: true });
    writeFileSync(join(mono, "results.trx"), "<TestRun/>");
    writeFileSync(join(mono, "packages", "app", "coverage", "lcov.info"), "SF:src/app.ts\nDA:1,1\nend_of_record\n");
    assert.equal(
      discoverCoverageFor(join(mono, "results.trx"), mono),
      resolvePath(mono, "packages", "app", "coverage", "lcov.info"),
    );
  } finally {
    rmSync(mono, { recursive: true, force: true });
  }
});

test("discovery ignores a stale report sitting beside the results file", () => {
  // Proximity was trusted on its own here, so a report left in TestResults/ by
  // a run weeks ago was served as this run's. That is the reading the whole
  // panel rests on -- "is the new code covered" answered from old measurements.
  const dir = mkdtempSync(join(tmpdir(), "cov-stale-sibling-"));
  try {
    mkdirSync(join(dir, "TestResults"), { recursive: true });
    const trx = join(dir, "TestResults", "run.trx");
    writeFileSync(trx, "<TestRun/>");
    const report = join(dir, "TestResults", "coverage.cobertura.xml");
    writeFileSync(report, '<coverage><packages><package><classes><class filename="a.ts"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>');
    const weeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
    utimesSync(report, weeksAgo, weeksAgo);
    assert.equal(discoverCoverageFor(trx, dir), null, "an old neighbour is still an old report");

    // Written by this run, it is exactly the report being looked for.
    const now = new Date();
    utimesSync(report, now, now);
    assert.equal(discoverCoverageFor(trx, dir), resolvePath(report));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discovery ignores a report an older run left behind", () => {
  // A report from hours ago measured different code. Offering it as this run's
  // reports coverage for lines the run never ran.
  const old = mkdtempSync(join(tmpdir(), "cov-old-"));
  try {
    mkdirSync(join(old, "coverage"), { recursive: true });
    mkdirSync(join(old, "TestResults"), { recursive: true });
    writeFileSync(join(old, "TestResults", "run.trx"), "<TestRun/>");
    const report = join(old, "coverage", "lcov.info");
    writeFileSync(report, "SF:src/app.ts\nDA:1,1\nend_of_record\n");
    const hoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(report, hoursAgo, hoursAgo);
    assert.equal(discoverCoverageFor(join(old, "TestResults", "run.trx"), old), null);

    // The same report written alongside the run is the one being looked for.
    const now = new Date();
    utimesSync(report, now, now);
    assert.equal(discoverCoverageFor(join(old, "TestResults", "run.trx"), old), resolvePath(report));
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});

test("a report is recognised from its opening rather than by reading all of it", () => {
  // Sizing up a candidate reads only the head, so a report far larger than that
  // window has to stay recognisable.
  const big = mkdtempSync(join(tmpdir(), "cov-big-"));
  try {
    const report = join(big, "coverage.cobertura.xml");
    writeFileSync(report, `${coberturaFor("src/calc.ts", [[2, 1]])}\n${"<!-- pad -->".repeat(50_000)}`);
    assert.equal(newestCoverageFileIn(big), resolvePath(report));
  } finally {
    rmSync(big, { recursive: true, force: true });
  }
});

test("pickBest breaks an mtime tie on the more recognisable name", () => {
  const best = pickBest([
    { path: "/x/report.xml", mtimeMs: 100, score: 0 },
    { path: "/x/coverage.cobertura.xml", mtimeMs: 100, score: 5 },
  ]);
  assert.equal(best, "/x/coverage.cobertura.xml");
});

test("commonSuffixSegments compares trailing segments case- and separator-insensitively", () => {
  assert.equal(commonSuffixSegments("src/app/calc.ts", "/ci/work/SRC/App/Calc.ts"), 3);
  assert.equal(commonSuffixSegments("src\\calc.ts", "other/calc.ts"), 1);
  assert.equal(commonSuffixSegments("a.ts", "b.ts"), 0);
  assert.equal(normalizeSlashes("a\\b\\c"), "a/b/c");
});

test("report paths resolve to real files, and unknown ones are left unresolved", () => {
  const parsed = parseCobertura(coberturaFor("src/calc.ts", [[2, 1]]));
  assert.ok(parsed);
  parsed.files.push({ path: "src/ghost.ts", lines: { 1: 0 }, coveredLines: 0, totalLines: 1 });

  const resolved = resolveReportSources(parsed, { projectRoot: root });
  const calc = resolved.files.find((f) => f.path === "src/calc.ts")!;
  assert.equal(calc.absPath, resolvePath(root, "src", "calc.ts"));
  // A report copied from CI legitimately names files that are not here; those
  // keep their percentages and simply cannot open a source view.
  assert.equal(resolved.files.find((f) => f.path === "src/ghost.ts")!.absPath, undefined);
});

test("a file spelled with both separators resolves once, not ambiguously", () => {
  // The resolver reads either separator, so both spellings land on the same
  // file on disk. While they stayed two entries, that made the absolute path
  // look like a name two different files had guessed at, and it was dropped
  // from both -- the file kept its numbers but could never open its source.
  const parsed = parseLcov("SF:src\\calc.ts\nDA:1,1\nend_of_record\nSF:src/calc.ts\nDA:2,0\nend_of_record\n");
  assert.ok(parsed);

  const resolved = resolveReportSources(parsed, { projectRoot: root });
  assert.equal(resolved.files.length, 1);
  assert.equal(resolved.files[0].absPath, resolvePath(root, "src", "calc.ts"));
});

// A report with no <sources> root, so only the project root and the filename
// index can locate its files.
function rootlessCobertura(paths: readonly string[]): string {
  const classes = paths
    .map((p, i) => `<class name="C${i}" filename="${p}"><lines><line number="1" hits="1" /></lines></class>`)
    .join("");
  return `<?xml version="1.0"?><coverage><packages><package><classes>${classes}</classes></package></packages></coverage>`;
}

test("folders are excluded by where they are, not by name alone", () => {
  // "coverage" at the top of a project is report output, but src/coverage/ is
  // this extension's own source -- excluding the name everywhere hid the files
  // the report was measuring. "packages" is a monorepo's entire source tree.
  const dir = mkdtempSync(join(tmpdir(), "cov-dirs-"));
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    mkdirSync(join(dir, "src", "coverage"), { recursive: true });
    mkdirSync(join(dir, "packages", "app", "src"), { recursive: true });
    mkdirSync(join(dir, "coverage"), { recursive: true });
    writeFileSync(join(dir, "src", "coverage", "rank.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "packages", "app", "src", "widget.ts"), "export const b = 2;\n");
    // Report output that happens to end in .ts. Were the root folder indexed
    // too, two files would answer to "rank.ts" and neither would resolve.
    writeFileSync(join(dir, "coverage", "rank.ts"), "generated\n");

    const resolved = resolveReportSources(parseCobertura(rootlessCobertura(["rank.ts", "widget.ts"]))!, { projectRoot: dir });
    assert.equal(resolved.files[0].absPath, resolvePath(dir, "src", "coverage", "rank.ts"));
    assert.equal(resolved.files[1].absPath, resolvePath(dir, "packages", "app", "src", "widget.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a filename guess that two report entries share belongs to neither", () => {
  // An aggregate JaCoCo report over two modules. Only one Util.java is checked
  // out here, so the index answers both with it -- and one of the two would
  // then open a source view of a different module's file.
  const dir = mkdtempSync(join(tmpdir(), "cov-shared-"));
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "Util.java"), "class Util {}\n");

    const parsed = parseCobertura(rootlessCobertura([
      "api/src/main/java/com/example/Util.java",
      "worker/src/main/java/com/example/Util.java",
    ]))!;
    const resolved = resolveReportSources(parsed, { projectRoot: dir });
    assert.deepEqual(resolved.files.map((f) => f.absPath), [undefined, undefined]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two files answering a report path equally well resolve to neither", () => {
  // Both share "com/Thing.java" with the report path, so the suffix score
  // cannot separate them and picking the first is a coin toss.
  const dir = mkdtempSync(join(tmpdir(), "cov-tied-"));
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    mkdirSync(join(dir, "a", "com"), { recursive: true });
    mkdirSync(join(dir, "b", "com"), { recursive: true });
    writeFileSync(join(dir, "a", "com", "Thing.java"), "class Thing {}\n");
    writeFileSync(join(dir, "b", "com", "Thing.java"), "class Thing {}\n");

    const resolved = resolveReportSources(parseCobertura(rootlessCobertura(["x/com/Thing.java"]))!, { projectRoot: dir });
    assert.equal(resolved.files[0].absPath, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a relative source root is read against the project, not the running process", () => {
  // A second file of the same name, so the filename fallback cannot rescue the
  // lookup: only the declared root can resolve this path.
  const other = join(root, "lib");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "calc.ts"), CALC_SOURCE);
  try {
    const parsed = parseCobertura(
      `<?xml version="1.0"?><coverage><sources><source>src</source></sources>`
      + `<packages><package><classes><class name="Calc" filename="calc.ts">`
      + `<lines><line number="2" hits="1" /></lines></class></classes></package></packages></coverage>`,
    );
    assert.ok(parsed);

    const resolved = resolveReportSources(parsed, { projectRoot: root });
    assert.equal(resolved.files[0].absPath, resolvePath(root, "src", "calc.ts"));
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("report paths are normalised to forward slashes so git and the UI agree", () => {
  // A Windows LCOV writes "src\calc.ts" while git always says "src/calc.ts".
  // Left as-is the same file appears under two spellings in patch coverage,
  // and the folder tree -- which splits on "/" -- refuses to nest.
  const parsed = parseCobertura(coberturaFor("src\\calc.ts", [[2, 1]]));
  assert.ok(parsed);
  assert.equal(parsed.files[0].path, "src/calc.ts", "normalised as the report is read");

  const resolved = resolveReportSources(parsed, { projectRoot: root });
  assert.equal(resolved.files[0].path, "src/calc.ts");
  // Still resolves to the real file: normalising display must not cost lookup.
  assert.equal(resolved.files[0].absPath, resolvePath(root, "src", "calc.ts"));
});

test("loadCoverageFile produces a payload with resolved sources", () => {
  // skipGit: the fixture lives in a temp dir, and the surrounding repository's
  // own diff would be noise.
  const result = loadCoverageFile(join(root, "TestResults", "abc-guid", "coverage.cobertura.xml"), {
    projectRoot: root,
    skipGit: true,
  });
  assert.ok(result.ok);
  const loaded = result.coverage;
  assert.equal(loaded.payload.format, "cobertura");
  assert.equal(loaded.payload.totals.totalLines, 3);
  assert.equal(loaded.payload.totals.percent, 33);
  assert.equal(loaded.payload.patch, null, "no diff means no new-code section");

  const summary = loaded.payload.files[0];
  assert.equal(summary.hasSource, true);
  assert.equal(summary.isTest, false);
  // The wire payload must stay small: per-line maps are served on demand.
  assert.equal((summary as unknown as Record<string, unknown>).lines, undefined);

  assert.ok(loaded.payload.hotspots.length > 0, "the uncovered block must be ranked");
  assert.equal(loaded.payload.hotspots[0].path, "src/calc.ts");
});

test("a stale report of an untracked file that grew shows the lines it never measured", () => {
  // The whole path in one: the source scan says which lines could run, the
  // untracked file's length says the report stopped short of them. This file
  // holds no comments or blanks, the case where an absent inert set has to mean
  // "never scanned" rather than "nothing to drop".
  const dir = mkdtempSync(join(tmpdir(), "cov-grown-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"grown"}');
    writeFileSync(join(dir, "src", "grown.ts"), "export const a = 1;\nexport const b = 2;");
    writeFileSync(
      join(dir, "coverage.cobertura.xml"),
      `<?xml version="1.0"?><coverage><sources><source>${dir}</source></sources>
        <packages><package><classes>
          <class name="Grown" filename="src/grown.ts"><lines><line number="1" hits="3" /></lines></class>
        </classes></package></packages></coverage>`,
    );
    // Untracked, so the change set is the whole file and git has no diff to give.
    const exec: GitExec = (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return dir + "\n";
      if (args[0] === "ls-files") return "src/grown.ts\n";
      return "";
    };
    const result = loadCoverageFile(join(dir, "coverage.cobertura.xml"), { projectRoot: dir, diff: { exec } });
    assert.ok(result.ok);
    const patch = result.ok ? result.coverage.payload.patch : null;
    assert.ok(patch);
    assert.equal(patch.unknownLines, 1, "line 2 arrived after the report was taken");
    assert.equal(patch.files[0].unknownLines, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCoverageFile reports why it could not load a file", () => {
  const missing = loadCoverageFile(join(root, "does-not-exist.xml"), { skipGit: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.reason, "missing");

  // A real file that simply isn't a coverage report.
  const notCoverage = loadCoverageFile(join(root, "TestResults", "run.trx"), { skipGit: true });
  assert.equal(notCoverage.ok, false);
  assert.equal(notCoverage.ok === false && notCoverage.reason, "not-coverage");
});

test("readSourceView annotates each line with its hit count", () => {
  const result = loadCoverageFile(join(root, "TestResults", "abc-guid", "coverage.cobertura.xml"), {
    projectRoot: root,
    skipGit: true,
  });
  assert.ok(result.ok);
  const view = readSourceView(result.coverage, "src/calc.ts");
  assert.notEqual(typeof view, "string");
  if (typeof view === "string") return;

  assert.equal(view.lines.length, 6);
  assert.equal(view.lines[0].hits, null, "a line absent from the report is not executable");
  assert.equal(view.lines[1].hits, 3);
  assert.equal(view.lines[4].hits, 0);
  assert.equal(view.lines[1].text, "  return a + b;");
  assert.equal(view.firstUncovered, 5, "the client scrolls straight to the first gap");
});

test("/source only serves files the loaded report names", () => {
  // The allow-list is the whole defence: the served path always comes from the
  // report's own entry, never from the request, so traversal is impossible by
  // construction rather than by filtering.
  const result = loadCoverageFile(join(root, "TestResults", "abc-guid", "coverage.cobertura.xml"), {
    projectRoot: root,
    skipGit: true,
  });
  assert.ok(result.ok);
  for (const hostile of [
    "../../../../etc/passwd",
    "src/../../../etc/passwd",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    join(root, "package.json"),
    "src/calc.ts\u0000.png",
    "",
  ]) {
    assert.equal(readSourceView(result.coverage, hostile), "unknown-file", `must refuse ${JSON.stringify(hostile)}`);
  }
});

test("a report entry with no file on disk is refused rather than guessed at", () => {
  const parsed = parseCobertura(coberturaFor("src/ghost.ts", [[1, 0]]))!;
  const loaded = {
    path: "x",
    mtimeMs: 0,
    report: resolveReportSources(parsed, { projectRoot: root }),
    payload: null as never,
    changedByPath: new Map(),
  };
  assert.equal(readSourceView(loaded, "src/ghost.ts"), "no-source");
});

test("entries differing only in case open their own source, not each other's", () => {
  // A report written on a case-sensitive filesystem can name both. The two are
  // given separate files here so a wrong match is visible in the text.
  const dir = mkdtempSync(join(tmpdir(), "cov-case-"));
  writeFileSync(join(dir, "upper.ts"), "UPPER\n");
  writeFileSync(join(dir, "lower.ts"), "lower\n");
  const entry = (path: string, absPath: string) => ({
    path,
    absPath,
    lines: { 1: 1 },
    coveredLines: 1,
    totalLines: 1,
  });
  const loaded = {
    path: "x",
    mtimeMs: 0,
    report: {
      format: "cobertura",
      sourceRoots: [],
      totals: { files: 2, coveredLines: 2, totalLines: 2, percent: 100 },
      files: [entry("src/Foo.ts", join(dir, "upper.ts")), entry("src/foo.ts", join(dir, "lower.ts"))],
    },
    payload: null as never,
    changedByPath: new Map(),
  } as never;

  const upper = readSourceView(loaded, "src/Foo.ts");
  const lower = readSourceView(loaded, "src/foo.ts");
  assert.equal(typeof upper === "string" ? upper : upper.lines[0].text, "UPPER");
  assert.equal(typeof lower === "string" ? lower : lower.lines[0].text, "lower");

  const backslashed = readSourceView(loaded, "src\\Foo.ts");
  assert.equal(typeof backslashed === "string" ? backslashed : backslashed.lines[0].text, "UPPER", "separators still don't matter");

  rmSync(dir, { recursive: true, force: true });
});

test("a lone entry is still found when the case does not match", () => {
  // Windows reports and git disagree on case, and one entry leaves no doubt
  // about which file is wanted.
  const dir = mkdtempSync(join(tmpdir(), "cov-case1-"));
  writeFileSync(join(dir, "calc.ts"), "only\n");
  const loaded = {
    path: "x",
    mtimeMs: 0,
    report: {
      format: "cobertura",
      sourceRoots: [],
      totals: { files: 1, coveredLines: 1, totalLines: 1, percent: 100 },
      files: [{ path: "src/calc.ts", absPath: join(dir, "calc.ts"), lines: { 1: 1 }, coveredLines: 1, totalLines: 1 }],
    },
    payload: null as never,
    changedByPath: new Map(),
  } as never;

  const view = readSourceView(loaded, "SRC/Calc.TS");
  assert.equal(typeof view === "string" ? view : view.lines[0].text, "only");

  rmSync(dir, { recursive: true, force: true });
});

test("a report path pointing outside the project resolves to nothing", () => {
  // The report is untrusted input and whatever it resolves to is what /source
  // reads back, so a path that escapes the project must not resolve at all --
  // as an absolute path, and as a "..". The file is named so nothing inside the
  // project shares it, or the filename index would find a legitimate match.
  const outside = mkdtempSync(join(tmpdir(), "cov-outside-"));
  writeFileSync(join(outside, "outside-secret.ts"), "SECRET\n");
  const abs = join(outside, "outside-secret.ts");
  const escape = normalizeSlashes(`../${join(outside, "outside-secret.ts").split(/[\\/]/).pop()}`);

  for (const hostile of [abs, `${normalizeSlashes(outside)}/outside-secret.ts`, escape]) {
    const parsed = parseCobertura(coberturaFor(hostile, [[1, 1]]))!;
    const resolved = resolveReportSources(parsed, { projectRoot: root });
    assert.equal(resolved.files[0].absPath, undefined, `must not resolve ${hostile}`);
    const loaded = { path: "x", mtimeMs: 0, report: resolved, payload: null as never, changedByPath: new Map() };
    assert.equal(readSourceView(loaded, resolved.files[0].path), "no-source");
  }

  // The same report, with the project root moved to where the file really is,
  // still resolves -- containment is the only reason the paths above failed.
  const inside = resolveReportSources(parseCobertura(coberturaFor(abs, [[1, 1]]))!, { projectRoot: outside });
  assert.ok(inside.files[0].absPath, "a contained path is unaffected");

  rmSync(outside, { recursive: true, force: true });
});

// Containment is decided on the string before anything is opened, because on
// Windows merely asking whether \\host\share\x exists opens an SMB connection
// and offers the caller's credentials to whoever answers. The report says where
// its sources are, so that host would be the report author's choice.
test("withinRoot decides containment without touching the filesystem", () => {
  assert.equal(withinRoot("/repo", "/repo/src/a.ts"), true);
  assert.equal(withinRoot("/repo", "/repo"), true, "the root itself is inside it");
  assert.equal(withinRoot("/repo/", "/repo/src/a.ts"), true, "a trailing separator is not a segment");
  assert.equal(withinRoot("/repo", "/repository/a.ts"), false, "a shared prefix is not a shared folder");
  assert.equal(withinRoot("/repo", "/etc/passwd"), false);
  assert.equal(withinRoot("C:\\repo", "C:\\repo\\src\\a.ts"), true, "either separator spelling");
  assert.equal(withinRoot("C:\\repo", "\\\\attacker\\share\\a.ts"), false, "a UNC path is never inside a local root");
  assert.equal(withinRoot("C:\\repo", "c:\\repo\\a.ts"), false, "case matters unless the caller says otherwise");
  assert.equal(withinRoot("C:\\repo", "c:\\repo\\a.ts", true), true);
});

test("a source root the report points elsewhere is dropped before it is probed", () => {
  // The roots list is report-controlled too, and it is used to build candidates
  // rather than being checked one at a time, so it needs the same gate.
  const parsed = parseCobertura(
    `<coverage><sources><source>\\\\attacker\\share</source><source>${root}</source></sources>` +
      `<packages><package><classes><class filename="src/calc.ts"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>`,
  )!;
  const resolved = resolveReportSources(parsed, { projectRoot: root });
  assert.equal(resolved.files[0].absPath, join(root, "src", "calc.ts"), "the legitimate root still resolves");
});

test("findByPath ignores case only when one entry can be meant", () => {
  const both = new Map([
    ["/repo/Foo.ts", "upper"],
    ["/repo/foo.ts", "lower"],
  ]);
  assert.equal(findByPath(both, "/repo/Foo.ts"), "upper");
  assert.equal(findByPath(both, "/repo/foo.ts"), "lower");
  assert.equal(findByPath(both, "/repo/FOO.ts"), undefined, "ambiguous, so no guess");
  assert.equal(findByPath(new Map([["/repo/calc.ts", "only"]]), "/repo/Calc.ts"), "only");
  assert.equal(findByPath(both, "/repo\\Foo.ts"), "upper", "separators still don't matter");
});

test("changed lines follow the file whose case they belong to", () => {
  // The changed-line map is keyed by absolute path. Lowercasing that key merged
  // two files on a case-sensitive checkout, so one file's new lines were marked
  // on the other -- and looking a key up in lowercase found neither.
  const dir = mkdtempSync(join(tmpdir(), "cov-changed-"));
  writeFileSync(join(dir, "upper.ts"), "a\nb\n");
  writeFileSync(join(dir, "lower.ts"), "a\nb\n");
  const upperAbs = join(dir, "upper.ts");
  const lowerAbs = join(dir, "lower.ts");
  const entry = (path: string, absPath: string) => ({ path, absPath, lines: { 1: 1, 2: 1 }, coveredLines: 2, totalLines: 2 });
  const loaded = {
    path: "x",
    mtimeMs: 0,
    report: {
      format: "cobertura",
      sourceRoots: [],
      totals: { files: 2, coveredLines: 4, totalLines: 4, percent: 100 },
      files: [entry("src/Foo.ts", upperAbs), entry("src/foo.ts", lowerAbs)],
    },
    payload: null as never,
    changedByPath: new Map([
      [normalizeSlashes(upperAbs), { path: "src/Foo.ts", absPath: upperAbs, lines: new Set([1]), all: false }],
      [normalizeSlashes(lowerAbs), { path: "src/foo.ts", absPath: lowerAbs, lines: new Set([2]), all: false }],
    ]),
  } as never;

  const upper = readSourceView(loaded, "src/Foo.ts");
  const lower = readSourceView(loaded, "src/foo.ts");
  assert.ok(typeof upper !== "string" && typeof lower !== "string");
  assert.deepEqual((upper as SourceFileView).lines.map((l) => l.changed), [true, false, false]);
  assert.deepEqual((lower as SourceFileView).lines.map((l) => l.changed), [false, true, false]);

  rmSync(dir, { recursive: true, force: true });
});

test("suggestCoverageCommand names the right command for the project in front of it", () => {
  // package.json alone -> a JS/TS suggestion; the point is that the empty state
  // never shows a generic "enable coverage somehow".
  const suggestion = suggestCoverageCommand(root);
  assert.ok(suggestion.command.length > 0);
  assert.ok(suggestion.outputHint.length > 0);
  assert.notEqual(suggestion.ecosystem, "your test runner");

  const dotnet = mkdtempSync(join(tmpdir(), "cov-dotnet-"));
  try {
    writeFileSync(join(dotnet, "App.csproj"), "<Project />");
    const hint = suggestCoverageCommand(dotnet);
    assert.equal(hint.ecosystem, ".NET (VSTest)");
    assert.match(hint.command, /dotnet test/);
    // The collector command is rejected by Microsoft.Testing.Platform, so the
    // panel must not present it as the only way to collect coverage.
    assert.equal(hint.alternative?.ecosystem, ".NET (Microsoft.Testing.Platform)");
  } finally {
    rmSync(dotnet, { recursive: true, force: true });
  }

  const mtp = mkdtempSync(join(tmpdir(), "cov-mtp-"));
  try {
    writeFileSync(join(mtp, "App.csproj"), '<Project Sdk="MSTest.Sdk/3.6.0" />');
    const hint = suggestCoverageCommand(mtp);
    assert.equal(hint.ecosystem, ".NET (Microsoft.Testing.Platform)");
    assert.match(hint.command, /--coverage/);
    assert.equal(hint.alternative?.ecosystem, ".NET (VSTest)");
  } finally {
    rmSync(mtp, { recursive: true, force: true });
  }
});

// The runner a .NET project actually uses, for the configurations a
// package-name heuristic gets wrong.
test("suggestCoverageCommand reads the runner settings rather than the package names", () => {
  const cases: [string, Record<string, string>, string][] = [
    // MSTest.Sdk defaults to the platform, but can be opted back out.
    ["MSTest.Sdk", { "App.csproj": '<Project Sdk="MSTest.Sdk/3.6.0" />' }, "mtp"],
    ["MSTest.Sdk with UseVSTest", { "App.csproj": '<Project Sdk="MSTest.Sdk/3.6.0"><PropertyGroup><UseVSTest>true</UseVSTest></PropertyGroup></Project>' }, "vstest"],
    // A named property is not an opt-in; only its value is.
    ["opted out explicitly", { "App.csproj": "<Project><PropertyGroup><UseMicrosoftTestingPlatform>false</UseMicrosoftTestingPlatform></PropertyGroup></Project>" }, "vstest"],
    // xunit.v3 ships the VSTest adapter too, so the package says nothing.
    ["xunit.v3 on the VSTest adapter", { "App.csproj": '<Project><ItemGroup><PackageReference Include="xunit.v3" /><PackageReference Include="xunit.runner.visualstudio" /></ItemGroup></Project>' }, "vstest"],
    ["xunit.v3 opted in", { "App.csproj": '<Project><PropertyGroup><UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner></PropertyGroup><ItemGroup><PackageReference Include="xunit.v3" /></ItemGroup></Project>' }, "mtp"],
    ["NUnit opted in via Directory.Build.props", { "App.csproj": "<Project />", "Directory.Build.props": "<Project><PropertyGroup><EnableNUnitRunner>true</EnableNUnitRunner></PropertyGroup></Project>" }, "mtp"],
  ];

  for (const [name, files, expected] of cases) {
    const dir = mkdtempSync(join(tmpdir(), "cov-runner-"));
    try {
      for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body);
      const hint = suggestCoverageCommand(dir);
      const got = hint.ecosystem.includes("Microsoft.Testing.Platform") ? "mtp" : "vstest";
      assert.equal(got, expected, name);
      // Whichever is primary, the other is always offered.
      assert.ok(hint.alternative);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Before .NET 10, and without the global.json opt-in, `dotnet test` rejects
// platform options that do not follow `--`.
test("suggestCoverageCommand picks the dotnet test syntax the project's mode accepts", () => {
  const dir = mkdtempSync(join(tmpdir(), "cov-mode-"));
  try {
    writeFileSync(join(dir, "App.csproj"), '<Project Sdk="MSTest.Sdk/3.6.0" />');
    assert.match(suggestCoverageCommand(dir).command, /dotnet test -- --coverage/);

    writeFileSync(join(dir, "global.json"), '{ "test": { "runner": "Microsoft.Testing.Platform" } }');
    assert.match(suggestCoverageCommand(dir).command, /dotnet test --coverage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("suggestCoverageCommand still returns something usable for an unknown project", () => {
  const bare = mkdtempSync(join(tmpdir(), "cov-unknown-"));
  try {
    const hint = suggestCoverageCommand(bare);
    assert.ok(hint.command.length > 0);
    assert.ok(hint.ecosystem.length > 0);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
