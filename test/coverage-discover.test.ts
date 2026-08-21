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
import { commonSuffixSegments, normalizeSlashes } from "../src/coverage/sources/paths.js";
import { loadCoverageFile } from "../src/coverage/load.js";
import { readSourceView } from "../src/coverage/sources/view.js";
import { suggestCoverageCommand } from "../src/coverage/suggest.js";
import { parseCobertura } from "../src/coverage/formats/cobertura.js";

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

test("report paths are normalised to forward slashes so git and the UI agree", () => {
  // A Windows LCOV writes "src\calc.ts" while git always says "src/calc.ts".
  // Left as-is the same file appears under two spellings in patch coverage,
  // and the folder tree -- which splits on "/" -- refuses to nest.
  const parsed = parseCobertura(coberturaFor("src/calc.ts", [[2, 1]]));
  assert.ok(parsed);
  parsed.files[0].path = "src\\calc.ts";

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
    assert.equal(hint.ecosystem, ".NET");
    assert.match(hint.command, /dotnet test/);
  } finally {
    rmSync(dotnet, { recursive: true, force: true });
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
