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
  buildCoverageRows,
  rowNote,
  toRanges,
  fmtRanges,
  headlinePercent,
  headlineTotals,
  patchHeadline,
} from "../src/client/coverageDerive.js";
import type { CoveragePayload, CoverageFileSummary, PatchCoverage, PatchFile, UncoveredRegion } from "../src/coverage/model/payload.js";

function file(path: string, coveredLines: number, totalLines: number, rest: Partial<CoverageFileSummary> = {}): CoverageFileSummary {
  return {
    path,
    coveredLines,
    totalLines,
    percent: totalLines ? Math.round((coveredLines / totalLines) * 100) : null,
    hasSource: true,
    changed: false,
    isTest: false,
    ...rest,
  };
}

function patchFile(path: string, covered: number[], uncovered: number[], unmeasured = false, changedLines?: number): PatchFile {
  return {
    path,
    coveredLines: covered,
    uncoveredLines: uncovered,
    percent: covered.length + uncovered.length ? Math.round((covered.length / (covered.length + uncovered.length)) * 100) : null,
    unmeasured,
    changedLines: changedLines ?? covered.length + uncovered.length,
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

// --- the merged file list ---------------------------------------------------

function region(path: string, start: number, end: number, lines: number, score: number, changed = false): UncoveredRegion {
  return { path, start, end, lines, changed, wholeFileUncovered: false, score };
}

// Everything the three old lists showed has to survive on one row, so these
// tests assert the merge from the direction that matters: no file appears
// twice, and no fact is dropped on the way in.
test("buildCoverageRows shows each file once, carrying its report, patch and hotspot facts together", () => {
  const cov = payload(
    { files: [patchFile("src/a.ts", [1, 2], [3, 4, 5])] },
    {
      files: [file("src/a.ts", 6, 10, { changed: true }), file("src/b.ts", 10, 10)],
      hotspots: [region("src/a.ts", 30, 44, 12, 900), region("src/a.ts", 60, 61, 2, 100)],
    },
  );
  const rows = buildCoverageRows(cov, "", "actionable");

  assert.equal(rows.filter((r) => r.path === "src/a.ts").length, 1, "one row per file, not one per list");
  const a = rows.find((r) => r.path === "src/a.ts")!;
  assert.equal(a.percent, 60, "report numbers survive");
  assert.equal(a.coveredLines, 6);
  assert.deepEqual(a.newUncovered, [3, 4, 5], "patch numbers survive");
  assert.equal(a.newTotal, 5);
  assert.equal(a.changed, true);
  assert.deepEqual(a.regions.map((h) => h.start), [30, 60], "ranked blocks survive, worst first");
});

test("buildCoverageRows keeps changed files the report never measured", () => {
  // These exist only in the patch, never in `files`. Dropping them would lose
  // the strongest signal the panel has -- new code no test even loaded -- and
  // it would look like an improvement, because the list would get shorter.
  const cov = payload(
    { files: [patchFile("src/ghost.ts", [], [], true)], unmeasuredFiles: 1 },
    { files: [file("src/a.ts", 5, 10)], hotspots: [] },
  );
  const rows = buildCoverageRows(cov, "", "actionable");

  const ghost = rows.find((r) => r.path === "src/ghost.ts");
  assert.ok(ghost, "a changed file absent from the report still gets a row");
  assert.equal(ghost.measured, false);
  assert.equal(ghost.changed, true);
  assert.equal(ghost.percent, null, "no data is not 0% -- they mean opposite things");
  assert.equal(rows[0]!.path, "src/ghost.ts", "and it leads, being the least understood");
});

test("buildCoverageRows matches paths across sources regardless of separator or case", () => {
  // The report, git and the filesystem each spell paths their own way. Matching
  // raw strings would produce two rows for one file on Windows.
  const cov = payload(
    { files: [patchFile("src\\A.ts", [1], [2])] },
    { files: [file("src/a.ts", 5, 10)], hotspots: [region("SRC/A.ts", 7, 9, 3, 50)] },
  );
  const rows = buildCoverageRows(cov, "", "actionable");

  assert.equal(rows.length, 1, "one file, however each tool spells it");
  assert.deepEqual(rows[0]!.newUncovered, [2]);
  assert.equal(rows[0]!.regions.length, 1);
});

test("buildCoverageRows keeps files whose paths differ only in case apart", () => {
  // A case-sensitive filesystem has two files here, and folding them together
  // hid one behind the other's percentage.
  const cov = payload(null, {
    files: [file("src/Foo.ts", 4, 4), file("src/foo.ts", 0, 4)],
    hotspots: [],
  });
  const rows = buildCoverageRows(cov, "");

  assert.deepEqual(rows.map((r) => r.path).sort(), ["src/Foo.ts", "src/foo.ts"]);
  assert.equal(rows.find((r) => r.path === "src/Foo.ts")!.percent, 100);
  assert.equal(rows.find((r) => r.path === "src/foo.ts")!.percent, 0);
});

test("buildCoverageRows orders by what most needs a test, and sinks test files", () => {
  const cov = payload(
    {
      files: [
        patchFile("src/small-gap.ts", [1, 2, 3], [4]),
        patchFile("src/big-gap.ts", [1], [2, 3, 4, 5]),
        patchFile("src/ghost.ts", [], [], true),
      ],
      unmeasuredFiles: 1,
    },
    {
      files: [
        file("src/small-gap.ts", 9, 10, { changed: true }),
        file("src/big-gap.ts", 5, 10, { changed: true }),
        file("src/covered-change.ts", 10, 10, { changed: true }),
        file("src/stale.ts", 2, 10),
        file("src/done.ts", 10, 10),
        file("test/a.test.ts", 0, 10, { isTest: true }),
      ],
      hotspots: [],
    },
  );
  const rows = buildCoverageRows(cov, "", "actionable").map((r) => r.path);

  assert.deepEqual(rows, [
    "src/ghost.ts",           // changed, nothing observed it
    "src/big-gap.ts",         // changed, most untested new lines
    "src/small-gap.ts",       // changed, fewer untested new lines
    "src/covered-change.ts",  // changed and fully covered
    "src/stale.ts",           // untouched, but has gaps
    "src/done.ts",            // untouched and covered
    "test/a.test.ts",         // test code last: covering it is not the goal
  ]);
});

test("buildCoverageRows offers plain orderings for browsing", () => {
  const cov = payload(null, {
    files: [file("src/b.ts", 1, 10), file("src/a.ts", 9, 10)],
    hotspots: [],
  });
  assert.deepEqual(buildCoverageRows(cov, "", "name").map((r) => r.path), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(buildCoverageRows(cov, "", "coverage").map((r) => r.path), ["src/b.ts", "src/a.ts"]);
});

test("buildCoverageRows filters on the whole path, case-insensitively", () => {
  const cov = payload(null, {
    files: [file("src/one.ts", 1, 10), file("lib/two.ts", 1, 10)],
    hotspots: [],
  });
  assert.deepEqual(buildCoverageRows(cov, "  LIB/  ", "name").map((r) => r.path), ["lib/two.ts"]);
  assert.deepEqual(buildCoverageRows(null, "", "name"), []);
});

test("rowNote states the changed-line verdict and the biggest gap on one line", () => {
  const cov = payload(
    { files: [patchFile("src/a.ts", [1, 2], [7, 8])] },
    {
      files: [file("src/a.ts", 6, 10, { changed: true })],
      hotspots: [region("src/a.ts", 30, 44, 12, 900), region("src/a.ts", 60, 61, 2, 100)],
    },
  );
  const note = rowNote(buildCoverageRows(cov, "", "actionable")[0]!);

  assert.match(note, /2 of 4 changed lines untested: 7\u20138/);
  assert.match(note, /biggest gap lines 30\u201344 \(12 untested\), \+1 more block/);
});

test("rowNote reassures rather than nags when the change set is fully covered", () => {
  const cov = payload(
    { files: [patchFile("src/a.ts", [1], [])] },
    { files: [file("src/a.ts", 10, 10, { changed: true })], hotspots: [] },
  );
  assert.equal(rowNote(buildCoverageRows(cov, "", "actionable")[0]!), "all 1 changed line covered");
});

test("rowNote says a file was never measured, and how much of it that hides", () => {
  // Fifteen blind spots that all read "changed, but never measured" cannot be
  // triaged: the reader has no way to tell a new module from a typo, and the
  // list they sit at the top of becomes a wall of identical text.
  const sized = payload(
    { files: [patchFile("src/ghost.ts", [], [], true, 212)], unmeasuredFiles: 1 },
    { files: [], hotspots: [] },
  );
  assert.equal(rowNote(buildCoverageRows(sized, "", "actionable")[0]!), "212 changed lines, none of them measured");

  // git can report a brand-new file without line detail; then size is unknown
  // rather than zero, and claiming "0 changed lines" would be a lie.
  const unsized = payload(
    { files: [patchFile("src/ghost.ts", [], [], true, 0)], unmeasuredFiles: 1 },
    { files: [], hotspots: [] },
  );
  assert.equal(rowNote(buildCoverageRows(unsized, "", "actionable")[0]!), "changed, but the report never measured it");
});

test("buildCoverageRows ranks blind spots by size, the only measure they have", () => {
  const cov = payload(
    {
      files: [
        patchFile("src/small.ts", [], [], true, 3),
        patchFile("src/huge.ts", [], [], true, 212),
        patchFile("src/mid.ts", [], [], true, 40),
      ],
      unmeasuredFiles: 3,
    },
    { files: [], hotspots: [] },
  );
  assert.deepEqual(
    buildCoverageRows(cov, "", "actionable").map((r) => r.path),
    ["src/huge.ts", "src/mid.ts", "src/small.ts"],
  );
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
