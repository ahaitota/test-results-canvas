// Tests for src/sources.ts: merging several results files into one run. The
// merge is a tagged concatenation, so what matters is that nothing is lost,
// nothing is reordered, and every row can be traced back to its file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSources } from "../src/sources.js";
import type { TestResult } from "../src/types.js";

const src = (label: string) => ({ label, path: `/x/${label}`, count: 0 });
const row = (name: string, extra: Partial<TestResult> = {}): TestResult => ({ name, status: "pass", ...extra });

test("mergeSources tags every row with the file it came from", () => {
  const merged = mergeSources([
    { source: src("a.trx"), results: [row("t1")] },
    { source: src("b.trx"), results: [row("t2")] },
  ]);
  assert.deepEqual(merged.map((t) => [t.name, t.source]), [["t1", "a.trx"], ["t2", "b.trx"]]);
});

test("mergeSources keeps source order and file order within a source", () => {
  const merged = mergeSources([
    { source: src("b.trx"), results: [row("b1"), row("b2")] },
    { source: src("a.trx"), results: [row("a1")] },
  ]);
  assert.deepEqual(merged.map((t) => t.name), ["b1", "b2", "a1"], "sources are not sorted behind the caller's back");
});

test("mergeSources keeps same-named tests from different files as separate rows", () => {
  // The AITestAgent case: two projects can both have a Setup test, and folding
  // them together would hide one project's result.
  const merged = mergeSources([
    { source: src("a.trx"), results: [row("Setup", { status: "pass" })] },
    { source: src("b.trx"), results: [row("Setup", { status: "fail", message: "boom" })] },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((t) => t.status), ["pass", "fail"]);
});

test("mergeSources lets a file that reported nothing contribute nothing", () => {
  const merged = mergeSources([
    { source: src("a.trx"), results: [row("t1")] },
    { source: src("empty.trx"), results: [] },
    { source: src("c.trx"), results: [row("t3")] },
  ]);
  assert.deepEqual(merged.map((t) => t.name), ["t1", "t3"]);
});

test("mergeSources copies rows rather than tagging the parser's own objects", () => {
  const original = row("t1");
  const merged = mergeSources([{ source: src("a.trx"), results: [original] }]);
  assert.equal(original.source, undefined, "the cached parse must stay untagged for a re-merge");
  assert.equal(merged[0].source, "a.trx");
});

test("mergeSources preserves the other fields a parser produced", () => {
  const merged = mergeSources([
    { source: src("a.trx"), results: [row("t1", { status: "fail", durationMs: 12, message: "boom", suite: "S", framework: "mstest" })] },
  ]);
  assert.deepEqual(merged[0], {
    name: "t1", status: "fail", durationMs: 12, message: "boom", suite: "S", framework: "mstest", source: "a.trx",
  });
});

test("mergeSources of nothing is an empty run, not a crash", () => {
  assert.deepEqual(mergeSources([]), []);
});
