// Tests for src/validate.ts: the SDK rejects schema violations first, so these
// helpers narrow `unknown` for the compiler and cover schema/handler drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { asString, asNumber, asResultInput, asOpenInput, asStringArray, asFilesInput, asAgentTestRef, MAX_SOURCE_PATHS } from "../src/validate.js";

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

const NOTHING = {
  name: undefined,
  resultsFile: undefined,
  resultsDir: undefined,
  resultsFiles: undefined,
  coverageFile: undefined,
  coverageDir: undefined,
  projectRoot: undefined,
};

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

test("asOpenInput extracts a merged file list and its name", () => {
  assert.deepEqual(asOpenInput({ name: "AITestAgentTests", resultsFiles: ["/a/r.trx", "/b/r.trx"] }), {
    ...NOTHING,
    name: "AITestAgentTests",
    resultsFiles: ["/a/r.trx", "/b/r.trx"],
  });
});

test("asOpenInput reports an unusable file list as absent, not empty", () => {
  // The server falls back to resultsFile/resultsDir on undefined, so a list
  // that held nothing usable must not read as "a list was given".
  assert.deepEqual(asOpenInput({ resultsFiles: "/a/r.trx" }), NOTHING, "a bare string is not a list");
  assert.deepEqual(asOpenInput({ resultsFiles: [] }), NOTHING);
  assert.deepEqual(asOpenInput({ resultsFiles: [null, 7, ""] }), NOTHING);
});

test("asStringArray keeps usable strings and drops the rest", () => {
  assert.deepEqual(asStringArray(["/a.trx", 7, null, "", { p: "/b.trx" }, "/b.trx"]), ["/a.trx", "/b.trx"]);
});

test("asStringArray returns nothing for values that are not arrays", () => {
  for (const bad of [undefined, null, "/a.trx", 5, { 0: "/a.trx", length: 1 }]) {
    assert.deepEqual(asStringArray(bad), [], `${JSON.stringify(bad) ?? "undefined"} should yield no paths`);
  }
});

test("asStringArray drops duplicates before applying the cap", () => {
  // Counting repeats towards the cap would let one path crowd out real files.
  assert.deepEqual(asStringArray(["/a.trx", "/a.trx", "/b.trx"], 2), ["/a.trx", "/b.trx"]);
});

test("asStringArray caps a runaway list", () => {
  const many = Array.from({ length: MAX_SOURCE_PATHS + 10 }, (_, i) => `/r${i}.trx`);
  assert.equal(asStringArray(many).length, MAX_SOURCE_PATHS);
  assert.equal(asStringArray(many).at(-1), `/r${MAX_SOURCE_PATHS - 1}.trx`, "the cap keeps the first paths given");
});

test("asFilesInput narrows the open_files action input", () => {
  assert.deepEqual(asFilesInput({ name: "Merged", files: ["/a.trx", 7, "/b.trx"] }), {
    name: "Merged",
    files: ["/a.trx", "/b.trx"],
  });
});

test("asFilesInput always yields a files array so a handler can reject it plainly", () => {
  assert.deepEqual(asFilesInput(undefined), { name: undefined, files: [] });
  assert.deepEqual(asFilesInput({ files: "/a.trx" }), { name: undefined, files: [] });
  assert.deepEqual(asFilesInput({ name: 5, files: [] }), { name: undefined, files: [] });
});

test("asAgentTestRef keeps a well-formed impacted-test reference", () => {
  assert.deepEqual(asAgentTestRef({ name: "adds", className: "CalcTests", reason: "calls the new helper" }), {
    name: "adds",
    className: "CalcTests",
    reason: "calls the new helper",
  });
});

test("asAgentTestRef requires a name and drops unusable extras", () => {
  // Without a name there is nothing to match a row against.
  assert.equal(asAgentTestRef({ className: "CalcTests" }), null);
  assert.equal(asAgentTestRef({ name: "" }), null);
  assert.equal(asAgentTestRef("adds"), null);
  assert.equal(asAgentTestRef(["adds"]), null);
  assert.equal(asAgentTestRef(null), null);
  assert.deepEqual(asAgentTestRef({ name: "adds", className: 7, reason: {} }), {
    name: "adds",
    className: undefined,
    reason: undefined,
  });
});
