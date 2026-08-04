// Row keys must follow a test across live refreshes: identical rows stay distinct,
// unchanged rows keep their key, and an ambiguous change collapses rather than
// transferring expansion to a different row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileRowKeys, pruneKeys, rowIdentity } from "../src/rowkey.js";
import type { TestResult } from "../src/types.js";

const row = (over: Partial<TestResult> = {}): TestResult => ({ name: "T", status: "pass", ...over });

test("a fresh payload gives every row a unique key, even fully identical rows", () => {
  const rows = [row({ className: "C", suite: "S", durationMs: 10 }), row({ className: "C", suite: "S", durationMs: 10 })];
  const { keys } = reconcileRowKeys(rows, [], [], new Map());
  assert.notEqual(keys[0], keys[1]);
});

test("an unchanged payload keeps every key", () => {
  const seq = new Map<string, number>();
  const p1 = [row({ name: "A", className: "C" }), row({ name: "B", className: "C" })];
  const k1 = reconcileRowKeys(p1, [], [], seq).keys;
  const p2 = [row({ name: "A", className: "C" }), row({ name: "B", className: "C" })];
  const k2 = reconcileRowKeys(p2, p1, k1, seq).keys;
  assert.deepEqual(k2, k1);
});

test("exact occurrenceSig match reuses the prior key regardless of arrival order", () => {
  const seq = new Map<string, number>();
  const p1 = [row({ className: "C", suite: "S", durationMs: 5 }), row({ className: "C", suite: "S", durationMs: 12 })];
  const k1 = reconcileRowKeys(p1, [], [], seq).keys;

  const p2 = [row({ className: "C", suite: "S", durationMs: 12 }), row({ className: "C", suite: "S", durationMs: 5 })];
  const k2 = reconcileRowKeys(p2, p1, k1, seq).keys;
  assert.equal(k2[1], k1[0]); // the 5ms row kept its key though it arrived last
  assert.equal(k2[0], k1[1]);
});

test("equal-signature rows pair up in arrival order (deterministic tie ordinals)", () => {
  const seq = new Map<string, number>();
  const same = { className: "C", suite: "S", durationMs: 10 };
  const p1 = [row(same), row(same)];
  const k1 = reconcileRowKeys(p1, [], [], seq).keys;
  const p2 = [row(same), row(same)];
  const k2 = reconcileRowKeys(p2, p1, k1, seq).keys;
  assert.deepEqual(k2, k1);
});

test("fresh keys never collide with a reused live key", () => {
  const seq = new Map<string, number>();
  const p1 = [row({ className: "C", suite: "S", durationMs: 5 })];
  const k1 = reconcileRowKeys(p1, [], [], seq).keys;
  const p2 = [row({ className: "C", suite: "S", durationMs: 5 }), row({ className: "C", suite: "S", durationMs: 9 })];
  const k2 = reconcileRowKeys(p2, p1, k1, seq).keys;
  assert.equal(k2[0], k1[0]);
  assert.notEqual(k2[1], k2[0]);
});

test("an ambiguous volatile change collapses expansion instead of transferring it", () => {
  const seq = new Map<string, number>();
  const p1 = [
    row({ className: "C", suite: "S", status: "fail", durationMs: 10 }),
    row({ className: "C", suite: "S", durationMs: 20 }),
  ];
  const k1 = reconcileRowKeys(p1, [], [], seq).keys;
  const expanded = new Set([k1[0]]); // user expands the 10ms/fail retry

  // Rerun: that retry's volatile data changed (now 30ms/pass) -> no exact match.
  const p2 = [row({ className: "C", suite: "S", durationMs: 30 }), row({ className: "C", suite: "S", durationMs: 20 })];
  const { keys: k2, reused } = reconcileRowKeys(p2, p1, k1, seq);
  const after = pruneKeys(expanded, reused);
  assert.ok(!after.has(k1[0]));       // old key dropped -> collapsed
  assert.ok(!after.has(k2[0]));       // expansion NOT transferred to the new row
  assert.notEqual(k2[0], k1[0]);
  assert.equal(k2[1], k1[1]);         // the untouched 20ms row is unaffected
});

test("switching to an unrelated payload drops every expanded key", () => {
  const seq = new Map<string, number>();
  const p1 = [row({ name: "old", className: "C" })];
  const k1 = reconcileRowKeys(p1, [], [], seq).keys;
  const expanded = new Set(k1);

  const p2 = [row({ name: "new", className: "D" })];
  const { reused } = reconcileRowKeys(p2, p1, k1, seq);
  assert.equal(pruneKeys(expanded, reused).size, 0);
});

test("pruneKeys returns the same set when nothing is stale", () => {
  const set = new Set(["a", "b"]);
  assert.equal(pruneKeys(set, new Set(["a", "b", "c"])), set);
});

test("rowIdentity separates same-named tests from different targets", () => {
  const net8 = row({ className: "C", framework: "net8.0" });
  const net9 = row({ className: "C", framework: "net9.0" });
  assert.notEqual(rowIdentity(net8), rowIdentity(net9));
});
