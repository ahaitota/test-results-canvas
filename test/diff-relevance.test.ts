// Unit tests for diff mode: which tests a change makes worth looking at.
// Everything here is a plain object -- git is read by the server and handed to
// computeRelevance(), so no test below touches a repository.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve as resolvePath } from "node:path";
import { computeRelevance, matchAgentTests, expectedTestNames, testTokens, identitiesOf } from "../src/diff/relevance.js";
import type { DiffResult, FileChanges } from "../src/coverage/gitdiff.js";
import type { TestResult } from "../src/types.js";

function t(name: string, extra: Partial<TestResult> = {}): TestResult {
  return { name, status: "pass", ...extra };
}

function file(path: string, isNew = false): FileChanges {
  // `all: true` is how gitdiff reports an untracked or newly added file: every
  // line is new, so there are no specific line numbers to carry.
  return { path, absPath: resolvePath("/repo", path), lines: new Set(isNew ? [] : [1]), all: isNew };
}

function diff(files: FileChanges[], against = "uncommitted changes"): DiffResult {
  return { root: resolvePath("/repo"), against, files };
}

// --- name conventions -------------------------------------------------------

test("expectedTestNames covers the affixes each ecosystem prefers", () => {
  const names = expectedTestNames("Calc");
  // Suffix (.NET, Java), prefix (Python), and the bare name (describe("Calc")).
  assert.ok(names.includes("calctests"));
  assert.ok(names.includes("calcspec"));
  assert.ok(names.includes("testcalc"));
  assert.ok(names.includes("calc"));
});

test("expectedTestNames refuses names too short to mean anything", () => {
  // "id" would pair with IdTests, TestId, and a good deal else besides.
  assert.deepEqual(expectedTestNames("id"), []);
  assert.deepEqual(expectedTestNames(""), []);
});

test("testTokens reads a fully qualified class, a path suite and a file alike", () => {
  const tokens = testTokens(t("adds", { className: "MyApp.Billing.CalcTests", suite: "tests/test_calc.py", file: "src/calc.test.ts" }));
  // The whole string, its stem, and each segment all count as a reading.
  assert.ok(tokens.includes("myappbillingcalctests"));
  assert.ok(tokens.includes("calctests"));
  assert.ok(tokens.includes("billing"));
  assert.ok(tokens.includes("testcalc"));
  assert.ok(tokens.includes("calctest"));
  // "py" and "ts" are below MIN_TOKEN and never make it in.
  assert.ok(!tokens.includes("py"));
  assert.ok(!tokens.includes("ts"));
});

// --- new ---------------------------------------------------------------------

test("a test the previous run never saw is new", () => {
  const results = [t("adds", { className: "CalcTests" }), t("subtracts", { className: "CalcTests" })];
  const baseline = identitiesOf([t("adds", { className: "CalcTests" })]);
  const out = computeRelevance({ results, baseline });
  assert.ok(out);
  assert.equal(out.tags[0], undefined);
  assert.equal(out.tags[1]?.kind, "new");
  assert.match(out.tags[1].reason, /previous run/);
  assert.equal(out.counts.new, 1);
  assert.equal(out.counts.relevant, 1);
  assert.equal(out.hasBaseline, true);
});

test("a test in a file git has never seen is new, with no baseline needed", () => {
  const results = [t("adds", { className: "CalcTests" })];
  const out = computeRelevance({ results, changes: diff([file("test/CalcTests.cs", true)]) });
  assert.ok(out);
  assert.equal(out.tags[0]?.kind, "new");
  assert.match(out.tags[0].reason, /new file/);
});

test("history outranks git: a brand new test in an edited file still reads as new", () => {
  const results = [t("adds", { className: "CalcTests" })];
  const out = computeRelevance({
    results,
    baseline: identitiesOf([t("subtracts", { className: "CalcTests" })]),
    changes: diff([file("test/CalcTests.cs")]),
  });
  assert.ok(out);
  assert.equal(out.tags[0]?.kind, "new");
});

// --- modified ----------------------------------------------------------------

test("a test whose own file changed is modified", () => {
  const results = [t("adds", { className: "CalcTests" })];
  const out = computeRelevance({ results, changes: diff([file("test/CalcTests.cs")]) });
  assert.ok(out);
  assert.equal(out.tags[0]?.kind, "modified");
  assert.match(out.tags[0].reason, /test\/CalcTests\.cs changed/);
  assert.equal(out.counts.modified, 1);
});

test("the file attribute matches even when the report spells a shorter path", () => {
  // Runners report paths from their own working directory, not the repo root.
  const results = [t("adds", { file: "tests/test_calc.py" })];
  const out = computeRelevance({ results, changes: diff([file("pkg/tests/test_calc.py")]) });
  assert.ok(out);
  assert.equal(out.tags[0]?.kind, "modified");
});

test("a same-named file in another folder is not a match", () => {
  // "other/tests/test_calc.py" ends with neither path, so nothing is claimed.
  const results = [t("adds", { file: "a/tests/test_calc.py", className: "unrelated" })];
  const out = computeRelevance({ results, changes: diff([file("b/tests/other_calc.py")]) });
  assert.ok(out);
  assert.equal(out.tags[0], undefined);
  assert.equal(out.counts.relevant, 0);
});

test("editing a test wins over editing what it covers", () => {
  const results = [t("adds", { className: "CalcTests", file: "test/CalcTests.cs" })];
  const out = computeRelevance({ results, changes: diff([file("src/Calc.cs"), file("test/CalcTests.cs")]) });
  assert.ok(out);
  assert.equal(out.tags[0]?.kind, "modified");
  assert.match(out.tags[0].reason, /CalcTests\.cs/);
});

// --- impacted ----------------------------------------------------------------

test("a changed production file reaches its test by name, across ecosystems", () => {
  const results = [
    t("adds", { className: "CalcTests" }),          // .NET / Java suffix
    t("adds", { suite: "test_calc.py" }),           // Python prefix
    t("adds", { file: "src/calc.test.ts" }),        // JS/TS infix
    t("adds", { className: "InvoiceTests" }),       // unrelated
  ];
  const out = computeRelevance({ results, changes: diff([file("src/Calc.cs")]) });
  assert.ok(out);
  assert.equal(out.tags[0]?.kind, "impacted");
  assert.equal(out.tags[1]?.kind, "impacted");
  assert.equal(out.tags[2]?.kind, "impacted");
  assert.equal(out.tags[3], undefined);
  assert.equal(out.counts.impacted, 3);
  assert.match(out.tags[0].reason, /src\/Calc\.cs changed/);
});

test("a changed test file does not impact tests that merely share its subject", () => {
  // A changed *test* file only claims its own tests; it is not production code
  // that other tests could be said to cover.
  const results = [t("adds", { className: "CalcHelperTests" })];
  const out = computeRelevance({ results, changes: diff([file("test/CalcTests.cs")]) });
  assert.ok(out);
  assert.equal(out.tags[0], undefined);
});

test("changes to non-source files tag nothing", () => {
  const results = [t("adds", { className: "ReadmeTests" })];
  const out = computeRelevance({ results, changes: diff([file("README.md"), file("docs/readme.txt")]) });
  assert.ok(out);
  assert.equal(out.counts.relevant, 0);
  assert.equal(out.changedFiles, 2);
});

// --- the payload -------------------------------------------------------------

test("no diff, no history and no agent means no diff mode at all", () => {
  // Null, rather than an empty payload: the UI should stay quiet instead of
  // announcing that nothing is relevant.
  assert.equal(computeRelevance({ results: [t("adds")] }), null);
  assert.equal(computeRelevance({ results: [t("adds")], changes: null, baseline: null }), null);
});

test("the payload names the scope and counts every changed file", () => {
  const files = Array.from({ length: 60 }, (_, i) => file(`src/f${i}.ts`));
  const out = computeRelevance({ results: [t("adds")], changes: diff(files, "this branch vs origin/main") });
  assert.ok(out);
  assert.equal(out.against, "this branch vs origin/main");
  assert.equal(out.changedFiles, 60);
  // The list is capped for the wire; the count above stays truthful.
  assert.equal(out.files.length, 50);
});

test("a baseline with no diff still describes itself", () => {
  const out = computeRelevance({ results: [t("adds")], baseline: identitiesOf([t("adds")]) });
  assert.ok(out);
  assert.equal(out.against, "the previous run");
  assert.equal(out.changedFiles, 0);
});

// --- the agent's assessment --------------------------------------------------

test("matchAgentTests resolves a bare name, a qualified one and a whole class", () => {
  const results = [
    t("adds", { className: "CalcTests" }),
    t("subtracts", { className: "CalcTests" }),
    t("renders", { className: "ViewTests" }),
  ];
  const { tags, unmatched } = matchAgentTests(results, [
    { name: "adds" },
    { name: "subtracts", className: "CalcTests", reason: "calls the rewritten helper" },
    { name: "ViewTests" },
  ]);
  assert.deepEqual([...tags.keys()].sort(), [0, 1, 2]);
  assert.equal(tags.get(1), "calls the rewritten helper");
  // A ref with no reason still gets a tooltip worth reading.
  assert.match(tags.get(0)!, /agent/);
  assert.deepEqual(unmatched, []);
});

test("matchAgentTests reports the names that matched nothing", () => {
  const { tags, unmatched } = matchAgentTests([t("adds")], [{ name: "nonexistent" }, { name: "" }]);
  assert.equal(tags.size, 0);
  // The empty ref is not worth reporting; the wrong name is.
  assert.deepEqual(unmatched, ["nonexistent"]);
});

test("a name shared by two rows tags both", () => {
  const results = [t("adds", { className: "A" }), t("adds", { className: "B" })];
  const { tags } = matchAgentTests(results, [{ name: "adds" }]);
  assert.deepEqual([...tags.keys()].sort(), [0, 1]);
});

test("the agent fills gaps and never overrules git", () => {
  const results = [t("adds", { className: "CalcTests" }), t("renders", { className: "ViewTests" })];
  const agent = new Map([[0, "agent says so"], [1, "reads the changed config"]]);
  const out = computeRelevance({ results, changes: diff([file("test/CalcTests.cs")]), agent });
  assert.ok(out);
  // Row 0 has a fact about it, so the agent's reading is set aside.
  assert.equal(out.tags[0]?.kind, "modified");
  assert.equal(out.tags[0].fromAgent, undefined);
  // Row 1 had nothing, so the agent's reading stands -- and is marked as its own.
  assert.equal(out.tags[1]?.kind, "impacted");
  assert.equal(out.tags[1].fromAgent, true);
  assert.equal(out.tags[1].reason, "reads the changed config");
});

test("the agent alone is enough to open diff mode", () => {
  const out = computeRelevance({ results: [t("adds")], agent: new Map([[0, "touches the parser"]]) });
  assert.ok(out);
  assert.equal(out.tags[0]?.fromAgent, true);
  assert.equal(out.against, "");
});
