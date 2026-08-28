// Tests for src/validate.ts: the SDK rejects schema violations first, so these
// helpers narrow `unknown` for the compiler and cover schema/handler drift.
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

const NOTHING = { resultsFile: undefined, resultsDir: undefined, coverageFile: undefined, coverageDir: undefined, projectRoot: undefined };

test("asOpenInput extracts string paths", () => {
  assert.deepEqual(asOpenInput({ resultsFile: "/a/r.trx" }), { ...NOTHING, resultsFile: "/a/r.trx" });
  assert.deepEqual(asOpenInput({ resultsDir: "/a" }), { ...NOTHING, resultsDir: "/a" });
  assert.deepEqual(asOpenInput({ coverageFile: "/a/cov.xml" }), { ...NOTHING, coverageFile: "/a/cov.xml" });
  assert.deepEqual(asOpenInput({ coverageDir: "/a/coverage" }), { ...NOTHING, coverageDir: "/a/coverage" });
  assert.deepEqual(asOpenInput({ projectRoot: "/a" }), { ...NOTHING, projectRoot: "/a" });
});

test("asOpenInput drops non-string paths so they never reach the filesystem", () => {
  assert.deepEqual(asOpenInput({ resultsFile: ["/a/r.trx"], resultsDir: 5, coverageFile: {}, coverageDir: true, projectRoot: 0 }), NOTHING);
});

test("asOpenInput tolerates a missing input object", () => {
  assert.deepEqual(asOpenInput(undefined), NOTHING);
  assert.deepEqual(asOpenInput({}), NOTHING);
});
