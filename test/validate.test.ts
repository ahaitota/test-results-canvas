// Tests for the agent-input validation boundary (src/validate.ts).
//
// The SDK rejects input that violates the declared JSON schemas before a
// handler runs, so these helpers are a second line of defence — they exist to
// narrow `unknown` for the compiler and to stay correct if a schema and its
// handler ever drift apart. The cases below are what that drift looks like:
// missing fields, nulls, and values of the wrong type.
import { test } from "node:test";
import assert from "node:assert/strict";
import { asString, asNumber, asResultInput, asOpenInput } from "../src/validate.js";

test("asString keeps non-empty strings and rejects everything else", () => {
  assert.equal(asString("results.trx"), "results.trx");
  assert.equal(asString(""), undefined);
  assert.equal(asString(undefined), undefined);
  assert.equal(asString(null), undefined);
  assert.equal(asString(42), undefined);
  assert.equal(asString(["a"]), undefined);
});

test("asNumber keeps finite numbers and rejects NaN/Infinity", () => {
  assert.equal(asNumber(12.5), 12.5);
  assert.equal(asNumber(0), 0);
  assert.equal(asNumber(NaN), undefined);
  assert.equal(asNumber(Infinity), undefined);
  assert.equal(asNumber("12"), undefined, "numeric strings are not coerced");
  assert.equal(asNumber(undefined), undefined);
});

test("asResultInput accepts a well-formed result", () => {
  assert.deepEqual(asResultInput({ name: "t1", status: "fail", durationMs: 8, message: "boom" }), {
    name: "t1",
    status: "fail",
    durationMs: 8,
    message: "boom",
  });
});

test("asResultInput requires a usable name", () => {
  assert.equal(asResultInput({ status: "pass" }), null, "missing name");
  assert.equal(asResultInput({ name: "" }), null, "empty name");
  assert.equal(asResultInput({ name: 7 }), null, "non-string name");
});

test("asResultInput rejects non-objects", () => {
  for (const bad of [null, undefined, "t1", 5, ["t1"]]) {
    assert.equal(asResultInput(bad), null, `${JSON.stringify(bad) ?? "undefined"} should be rejected`);
  }
});

test("asResultInput drops bad optional fields but keeps the result", () => {
  const result = asResultInput({ name: "t1", durationMs: "fast", message: 99 });
  assert.deepEqual(result, { name: "t1", status: undefined, durationMs: undefined, message: undefined });
});

test("asResultInput passes status through untouched for the server to normalize", () => {
  assert.equal(asResultInput({ name: "t1", status: "Passed" })?.status, "Passed");
  assert.equal(asResultInput({ name: "t1", status: 3 })?.status, 3);
});

test("asOpenInput extracts string paths", () => {
  assert.deepEqual(asOpenInput({ resultsFile: "/a/r.trx" }), { resultsFile: "/a/r.trx", resultsDir: undefined });
  assert.deepEqual(asOpenInput({ resultsDir: "/a" }), { resultsFile: undefined, resultsDir: "/a" });
});

test("asOpenInput drops non-string paths so they never reach the filesystem", () => {
  assert.deepEqual(asOpenInput({ resultsFile: ["/a/r.trx"], resultsDir: 5 }), {
    resultsFile: undefined,
    resultsDir: undefined,
  });
});

test("asOpenInput tolerates a missing input object", () => {
  assert.deepEqual(asOpenInput(undefined), { resultsFile: undefined, resultsDir: undefined });
  assert.deepEqual(asOpenInput({}), { resultsFile: undefined, resultsDir: undefined });
});
