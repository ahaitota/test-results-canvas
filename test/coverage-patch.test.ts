// Unit tests for the "did the new code get tested?" pipeline: git diff parsing,
// the changed-lines/coverage intersection, and the ranking of what is worth
// covering. git is injected, so nothing here builds a throwaway repository.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve as resolvePath } from "node:path";
import { parseUnifiedDiff, changedLines } from "../src/coverage/gitdiff.js";
import type { GitExec, FileChanges } from "../src/coverage/gitdiff.js";
import { computePatchCoverage, matchCoverageFile, toRanges } from "../src/coverage/patch.js";
import { rankUncovered } from "../src/coverage/rank.js";
import { isProductionSource, isTestPath, isGeneratedPath } from "../src/coverage/classify.js";
import { buildFiles, totalsOf } from "../src/coverage/types.js";
import type { CoverageReport, LineHits } from "../src/coverage/types.js";

function report(entries: { path: string; lines: LineHits }[]): CoverageReport {
  const files = buildFiles(entries);
  return { format: "lcov", files, totals: totalsOf(files), sourceRoots: [] };
}

function change(path: string, lines: number[], all = false): FileChanges {
  return { path, absPath: resolvePath("/repo", path), lines: new Set(lines), all };
}

// --- git diff parsing -------------------------------------------------------

test("parseUnifiedDiff reads added line numbers straight from hunk headers", () => {
  // --unified=0 means the header alone is authoritative: no counting of "+".
  const diff = [
    "diff --git a/src/calc.ts b/src/calc.ts",
    "--- a/src/calc.ts",
    "+++ b/src/calc.ts",
    "@@ -10,0 +11,3 @@",
    "+one",
    "+two",
    "+three",
    "@@ -40,2 +44 @@",
    "+merged",
  ].join("\n");
  const map = parseUnifiedDiff(diff);
  assert.deepEqual([...map.get("src/calc.ts")!].sort((a, b) => a - b), [11, 12, 13, 44]);
});

test("parseUnifiedDiff ignores deletions and drops no-op renames", () => {
  const diff = [
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,5 +0,0 @@",
    "--- a/old.ts",
    "+++ b/new.ts",
  ].join("\n");
  const map = parseUnifiedDiff(diff);
  assert.equal(map.has("gone.ts"), false, "a deleted file has no new lines");
  assert.equal(map.has("new.ts"), false, "a rename with no edits is not a change to cover");
});

test("parseUnifiedDiff unquotes paths git escaped", () => {
  const diff = ['--- "a/src/od\\td.ts"', '+++ "b/src/od\\td.ts"', "@@ -0,0 +1 @@", "+x"].join("\n");
  const map = parseUnifiedDiff(diff);
  assert.deepEqual([...map.keys()], ["src/od\td.ts"]);
});

test("changedLines prefers uncommitted work and marks untracked files as wholly new", () => {
  const calls: string[][] = [];
  const git: GitExec = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return "true\n";
    if (args[0] === "ls-files") return "src/brand-new.ts\n";
    if (args[0] === "diff") return "--- a/src/calc.ts\n+++ b/src/calc.ts\n@@ -1,0 +2,2 @@\n+a\n+b\n";
    return null;
  };
  const result = changedLines("/repo", { exec: git });
  assert.ok(result);
  assert.equal(result.against, "uncommitted changes");

  const brandNew = result.files.find((f) => f.path === "src/brand-new.ts")!;
  assert.equal(brandNew.all, true, "an untracked file is new in its entirety");
  const edited = result.files.find((f) => f.path === "src/calc.ts")!;
  assert.deepEqual([...edited.lines], [2, 3]);
  assert.ok(!calls.some((c) => c[0] === "merge-base"), "a dirty tree must not fall back to the branch diff");
});

test("changedLines falls back to the merge-base when the tree is clean", () => {
  const git: GitExec = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
    if (args[0] === "ls-files") return "";
    if (args[0] === "diff" && args[args.length - 1] === "HEAD") return "";
    if (args[0] === "symbolic-ref") return "origin/main\n";
    if (args[0] === "merge-base") return "abc123\n";
    if (args[0] === "diff") return "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -0,0 +7 @@\n+n\n";
    return null;
  };
  const result = changedLines("/repo", { exec: git });
  assert.ok(result);
  assert.equal(result.against, "this branch vs origin/main");
  assert.deepEqual([...result.files[0].lines], [7]);
});

test("changedLines resolves paths against git's own top level, not the folder it was given", () => {
  // Called with a monorepo package directory, git still reports repo-relative
  // paths; resolving them against the package would fabricate paths that match
  // nothing in the coverage report.
  const git: GitExec = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${resolvePath("/repo")}\n`;
    if (args[0] === "ls-files") return "";
    if (args[0] === "diff") return "--- a/packages/app/src/x.ts\n+++ b/packages/app/src/x.ts\n@@ -0,0 +1 @@\n+n\n";
    return null;
  };
  const result = changedLines(resolvePath("/repo/packages/app"), { exec: git });
  assert.ok(result);
  assert.equal(result.root, resolvePath("/repo"));
  assert.equal(result.files[0].absPath, resolvePath("/repo/packages/app/src/x.ts"));
});

test("changedLines degrades to null outside a repository rather than throwing", () => {
  assert.equal(changedLines("/repo", { exec: () => null }), null);
});

// --- patch coverage ---------------------------------------------------------

test("computePatchCoverage counts only the lines that changed", () => {
  // The file is 50% covered overall, but every *changed* line ran -- which is
  // the distinction the whole feature rests on.
  const rep = report([{ path: "src/calc.ts", lines: { 1: 0, 2: 0, 10: 3, 11: 4 } }]);
  const patch = computePatchCoverage(rep, { against: "uncommitted changes", files: [change("src/calc.ts", [10, 11])] });
  assert.ok(patch);
  assert.equal(patch.total, 2);
  assert.equal(patch.covered, 2);
  assert.equal(patch.percent, 100);
  assert.deepEqual(patch.files[0].uncoveredLines, []);
});

test("computePatchCoverage surfaces new lines that no test reached", () => {
  const rep = report([{ path: "src/calc.ts", lines: { 10: 1, 11: 0, 12: 0 } }]);
  const patch = computePatchCoverage(rep, { against: "uncommitted changes", files: [change("src/calc.ts", [10, 11, 12])] });
  assert.ok(patch);
  assert.equal(patch.percent, 33);
  assert.deepEqual(patch.files[0].uncoveredLines, [11, 12]);
});

test("a brand-new file counts every executable line as new", () => {
  const rep = report([{ path: "src/brand-new.ts", lines: { 1: 0, 2: 0, 3: 1 } }]);
  const patch = computePatchCoverage(rep, {
    against: "uncommitted changes",
    files: [change("src/brand-new.ts", [], true)],
  });
  assert.ok(patch);
  assert.equal(patch.total, 3);
  assert.deepEqual(patch.files[0].uncoveredLines, [1, 2]);
});

test("a changed production file absent from the report is reported as unmeasured", () => {
  // This is the agent-wrote-a-file-and-no-test-touched-it case, and it is the
  // single most useful thing the panel can say.
  const patch = computePatchCoverage(report([{ path: "src/other.ts", lines: { 1: 1 } }]), {
    against: "uncommitted changes",
    files: [change("src/untested.ts", [1, 2, 3])],
  });
  assert.ok(patch);
  assert.equal(patch.unmeasuredFiles, 1);
  assert.equal(patch.files[0].unmeasured, true);
  assert.equal(patch.files[0].path, "src/untested.ts");
});

test("changed docs and test files do not distort patch coverage", () => {
  const patch = computePatchCoverage(report([{ path: "src/calc.ts", lines: { 1: 1 } }]), {
    against: "uncommitted changes",
    files: [change("README.md", [1]), change("test/calc.test.ts", [1, 2]), change("src/calc.ts", [1])],
  });
  assert.ok(patch);
  assert.equal(patch.files.length, 1);
  assert.equal(patch.files[0].path, "src/calc.ts");
});

test("comment-only edits produce no patch entry", () => {
  // Line 99 is not in the hit map, so it is not executable; a reformat should
  // not be reported as untested code.
  const patch = computePatchCoverage(report([{ path: "src/calc.ts", lines: { 1: 1 } }]), {
    against: "uncommitted changes",
    files: [change("src/calc.ts", [99])],
  });
  assert.equal(patch, null);
});

test("computePatchCoverage returns null when there is no diff at all", () => {
  assert.equal(computePatchCoverage(report([{ path: "a.ts", lines: { 1: 1 } }]), null), null);
});

test("matchCoverageFile pairs a repo-relative diff path with an absolute report path", () => {
  // LCOV written on CI carries the runner's absolute paths; git speaks
  // repo-relative. Matching on trailing segments is what lines them up.
  const files = report([
    { path: "/home/runner/work/repo/src/app/calc.ts", lines: { 1: 1 } },
    { path: "/home/runner/work/repo/src/other/calc.ts", lines: { 1: 1 } },
  ]).files;
  const matched = matchCoverageFile(change("src/app/calc.ts", [1]), files);
  assert.equal(matched?.path, "/home/runner/work/repo/src/app/calc.ts");
});

test("matchCoverageFile refuses a match on filename alone", () => {
  const files = report([{ path: "vendor/lib/calc.ts", lines: { 1: 1 } }]).files;
  assert.equal(matchCoverageFile(change("src/calc.ts", [1]), files), undefined);
});

test("toRanges collapses runs and bridges a single-line gap", () => {
  // The gap tolerance keeps a closing brace between two uncovered statements
  // from splitting one region into two.
  assert.deepEqual(toRanges([3, 4, 5]), [{ start: 3, end: 5 }]);
  assert.deepEqual(toRanges([3, 5]), [{ start: 3, end: 5 }]);
  assert.deepEqual(toRanges([3, 9]), [{ start: 3, end: 3 }, { start: 9, end: 9 }]);
  assert.deepEqual(toRanges([]), []);
});

// --- classification and ranking ---------------------------------------------

test("classify separates production code from tests and generated output", () => {
  assert.equal(isProductionSource("src/app/calc.ts"), true);
  assert.equal(isProductionSource("README.md"), false);
  assert.equal(isTestPath("test/calc.test.ts"), true);
  assert.equal(isTestPath("src/App.Tests/CalcTests.cs"), true);
  assert.equal(isProductionSource("test/calc.test.ts"), false);
  assert.equal(isGeneratedPath("obj/Form1.Designer.cs"), true);
  assert.equal(isGeneratedPath("dist/app.min.js"), true);
  assert.equal(isProductionSource("obj/Form1.Designer.cs"), false);
});

test("rankUncovered puts a changed file ahead of a bigger untouched gap", () => {
  const rep = report([
    { path: "src/quiet.ts", lines: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i + 1, 0])) },
    { path: "src/edited.ts", lines: { 1: 1, 5: 0, 6: 0 } },
  ]);
  const ranked = rankUncovered(rep, { changedPaths: ["src/edited.ts"] });
  assert.equal(ranked[0].path, "src/edited.ts", "recency of change outranks raw size");
  assert.equal(ranked[0].changed, true);
});

test("rankUncovered ignores tests and generated files", () => {
  const rep = report([
    { path: "test/calc.test.ts", lines: { 1: 0, 2: 0, 3: 0 } },
    { path: "obj/Form1.Designer.cs", lines: { 1: 0, 2: 0, 3: 0 } },
    { path: "src/real.ts", lines: { 1: 0 } },
  ]);
  const ranked = rankUncovered(rep, { changedPaths: [] });
  assert.deepEqual(ranked.map((r) => r.path), ["src/real.ts"]);
});

test("rankUncovered flags a file no test reaches at all", () => {
  const rep = report([{ path: "src/dead.ts", lines: { 1: 0, 2: 0, 3: 0 } }]);
  const ranked = rankUncovered(rep, { changedPaths: [] });
  assert.equal(ranked[0].wholeFileUncovered, true);
  assert.equal(ranked[0].lines, 3);
  assert.equal(ranked[0].start, 1);
  assert.equal(ranked[0].end, 3);
});

test("rankUncovered returns nothing when everything is covered", () => {
  assert.deepEqual(rankUncovered(report([{ path: "src/a.ts", lines: { 1: 1, 2: 2 } }]), { changedPaths: [] }), []);
});

test("rankUncovered caps its output so the panel stays readable", () => {
  const entries = Array.from({ length: 80 }, (_, i) => ({ path: `src/f${i}.ts`, lines: { 1: 0 } }));
  assert.ok(rankUncovered(report(entries), { changedPaths: [] }).length <= 25);
});
