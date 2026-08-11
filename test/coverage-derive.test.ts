// Unit tests for the coverage view's pure derivations. These live in the client
// folder but import nothing host-specific, so they run under node --test like
// any other module -- which is the point: before this file existed the whole of
// coverageDerive.ts showed up in its own report as "no coverage data".
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bandOf,
  folderOf,
  baseOf,
  buildCoverageGroups,
  toRanges,
  fmtRanges,
  headlinePercent,
  headlineTotals,
  patchHeadline,
} from "../src/client/coverageDerive.js";
import type { CoveragePayload, CoverageFileSummary, PatchCoverage, PatchFile } from "../src/coverage/payload.js";

function file(path: string, coveredLines: number, totalLines: number): CoverageFileSummary {
  return {
    path,
    coveredLines,
    totalLines,
    percent: totalLines ? Math.round((coveredLines / totalLines) * 100) : null,
    hasSource: true,
    changed: false,
    isTest: false,
  };
}

function patchFile(path: string, covered: number[], uncovered: number[], unmeasured = false): PatchFile {
  return {
    path,
    coveredLines: covered,
    uncoveredLines: uncovered,
    percent: covered.length + uncovered.length ? Math.round((covered.length / (covered.length + uncovered.length)) * 100) : null,
    unmeasured,
  };
}

function payload(patch: Partial<PatchCoverage> | null, rest: Partial<CoveragePayload> = {}): CoveragePayload {
  const full = patch
    ? { against: "origin/main", files: [], covered: 0, total: 0, percent: null, unmeasuredFiles: 0, ...patch }
    : null;
  return { patch: full, ...rest } as unknown as CoveragePayload;
}

// --- bands and paths --------------------------------------------------------

test("bandOf uses the thresholds CI gates use, and distinguishes 'no data' from zero", () => {
  assert.equal(bandOf(80), "high");
  assert.equal(bandOf(79), "medium");
  assert.equal(bandOf(50), "medium");
  assert.equal(bandOf(49), "low");
  assert.equal(bandOf(0), "low", "0% is a measured result, not an absent one");
  assert.equal(bandOf(null), "none");
});

test("folderOf and baseOf normalise separators so Windows reports group like the rest", () => {
  assert.equal(folderOf("src\\coverage\\rank.ts"), "src/coverage");
  assert.equal(folderOf("src/coverage/rank.ts"), "src/coverage");
  assert.equal(folderOf("README.md"), ".", "root files still land in exactly one group");
  assert.equal(baseOf("src\\coverage\\rank.ts"), "rank.ts");
  assert.equal(baseOf("rank.ts"), "rank.ts");
  assert.equal(baseOf(""), "");
});

// --- grouping ---------------------------------------------------------------

test("buildCoverageGroups puts the folders that need work first", () => {
  const groups = buildCoverageGroups(
    [file("src/a/one.ts", 9, 10), file("src/b/two.ts", 1, 10), file("src/b/three.ts", 5, 10)],
    "",
  );
  assert.deepEqual(groups.map((g) => g.key), ["src/b", "src/a"]);
  const worst = groups[0]!;
  assert.equal(worst.totalLines, 20);
  assert.equal(worst.coveredLines, 6);
  assert.equal(worst.percent, 30);
  assert.deepEqual(worst.files.map((f) => f.path), ["src/b/two.ts", "src/b/three.ts"]);
});

test("buildCoverageGroups filters case-insensitively and drops emptied folders", () => {
  const files = [file("src/a/one.ts", 9, 10), file("src/b/two.ts", 1, 10)];
  const groups = buildCoverageGroups(files, "  TWO  ");
  assert.deepEqual(groups.map((g) => g.key), ["src/b"]);
  assert.equal(groups[0]!.files.length, 1);
});

test("buildCoverageGroups reports no percentage for a folder with nothing measurable", () => {
  const groups = buildCoverageGroups([file("src/a/empty.ts", 0, 0)], "");
  assert.equal(groups[0]!.percent, null, "0/0 must not read as 0% coverage");
});

// --- line ranges ------------------------------------------------------------

test("toRanges collapses runs and tolerates a one-line gap, matching the server", () => {
  assert.deepEqual(toRanges([3, 1, 2]), [{ start: 1, end: 3 }]);
  assert.deepEqual(toRanges([1, 3]), [{ start: 1, end: 3 }], "a single non-executable line does not split a region");
  assert.deepEqual(toRanges([1, 4]), [{ start: 1, end: 1 }, { start: 4, end: 4 }]);
  assert.deepEqual(toRanges([]), []);
});

test("fmtRanges renders single lines bare and caps the list", () => {
  assert.equal(fmtRanges([5]), "5");
  assert.equal(fmtRanges([5, 6, 7]), "5\u20137");
  assert.equal(fmtRanges([1, 4, 7, 10], 2), "1, 4, +2 more");
});

// --- headline numbers -------------------------------------------------------

test("headlinePercent prefers production coverage over the whole-report figure", () => {
  const totals = { files: 3, coveredLines: 88, totalLines: 100, percent: 88 };
  assert.equal(headlinePercent(payload(null, { productionPercent: 62, totals })), 62);
  assert.equal(headlinePercent(payload(null, { productionPercent: null, totals })), 88);
  assert.equal(headlinePercent(null), null);
});

test("headlineTotals draws its fraction from whichever population the percentage used", () => {
  // A report that measures the test project too: 88/100 overall, but the code
  // that ships is 40/65. Printing "62%" beside "88/100 lines" would show a
  // reader two populations and invite them to check the arithmetic and find it
  // wrong -- the failure that prompted this function.
  const totals = { files: 3, coveredLines: 88, totalLines: 100, percent: 88 };
  const productionTotals = { files: 2, coveredLines: 40, totalLines: 65 };

  assert.deepEqual(
    headlineTotals(payload(null, { productionPercent: 62, productionTotals, totals })),
    productionTotals,
  );

  // Nothing classified as production: the percentage falls back to the whole
  // report, so the fraction has to fall back with it.
  assert.deepEqual(
    headlineTotals(payload(null, { productionPercent: null, productionTotals, totals })),
    totals,
  );

  assert.deepEqual(headlineTotals(null), { coveredLines: 0, totalLines: 0, files: 0 });
});

test("patchHeadline names the uncovered lines", () => {
  const headline = patchHeadline(payload({ covered: 15, total: 18, files: [patchFile("src/a.ts", [1], [2])] }));
  assert.equal(headline, "3 of 18 changed lines not covered");
});

test("patchHeadline says so when the change set is fully covered", () => {
  assert.equal(patchHeadline(payload({ covered: 1, total: 1 })), "All 1 changed line is covered");
  assert.equal(patchHeadline(payload({ covered: 4, total: 4 })), "All 4 changed lines are covered");
});

// The regression this file was written for. Reporting only the measured subset
// reads as if it were the whole change set: a new file that no test imports
// contributes no uncovered lines *because* nothing observed it, so silence
// there is the opposite of good news.
test("patchHeadline always names files the report never measured", () => {
  assert.equal(
    patchHeadline(payload({ covered: 1633, total: 2156, unmeasuredFiles: 15 })),
    "523 of 2156 changed lines not covered, plus 15 changed files with no coverage data",
  );
});

test("patchHeadline does not claim a clean sweep while files are unmeasured", () => {
  const headline = patchHeadline(payload({ covered: 10, total: 10, unmeasuredFiles: 1 }));
  assert.equal(headline, "All 10 changed lines are covered, plus 1 changed file with no coverage data");
});

test("patchHeadline reports unmeasured files alone when nothing was measured", () => {
  assert.equal(patchHeadline(payload({ covered: 0, total: 0, unmeasuredFiles: 3 })), "3 changed files with no coverage data");
});

test("patchHeadline is empty without a patch comparison", () => {
  assert.equal(patchHeadline(payload(null)), "");
  assert.equal(patchHeadline(null), "");
});
