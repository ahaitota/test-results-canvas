// Unit tests for the TRX serialize/parse module.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeTrx, parseTrx } from "../src/parsers/trx.mjs";

const byName = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));

test("serializeTrx writes a valid TestRun with correct counters", () => {
  const xml = serializeTrx([
    { name: "a", status: "pass", durationMs: 42 },
    { name: "b", status: "fail", durationMs: 15, message: "Expected 401 but got 200" },
    { name: "c", status: "skip" },
  ]);
  assert.match(xml, /<TestRun\b/);
  assert.match(xml, /total="3"/);
  assert.match(xml, /executed="2"/);
  assert.match(xml, /passed="1"/);
  assert.match(xml, /failed="1"/);
  assert.match(xml, /notExecuted="1"/);
  // Overall run outcome is Failed when any test fails.
  assert.match(xml, /<ResultSummary outcome="Failed">/);
});

test("serializeTrx embeds an ErrorInfo message for failing tests only", () => {
  const xml = serializeTrx([
    { name: "a", status: "pass", durationMs: 1 },
    { name: "b", status: "fail", message: "boom" },
  ]);
  assert.match(xml, /<ErrorInfo>[\s\S]*?<Message>boom<\/Message>[\s\S]*?<\/ErrorInfo>/);
  // The passing test must not carry an ErrorInfo block.
  assert.equal((xml.match(/<ErrorInfo>/g) || []).length, 1);
});

test("serializeTrx reports overall outcome Completed when nothing fails", () => {
  const xml = serializeTrx([
    { name: "a", status: "pass" },
    { name: "b", status: "skip" },
  ]);
  assert.match(xml, /<ResultSummary outcome="Completed">/);
});

test("parseTrx reads every result back with mapped status", () => {
  const xml = serializeTrx([
    { name: "a", status: "pass", durationMs: 42 },
    { name: "b", status: "fail", durationMs: 15, message: "nope" },
    { name: "c", status: "skip" },
  ]);
  const rows = byName(parseTrx(xml));
  assert.equal(Object.keys(rows).length, 3);
  assert.equal(rows.a.status, "pass");
  assert.equal(rows.b.status, "fail");
  assert.equal(rows.c.status, "skip");
});

test("serialize -> parse round-trips duration, message and className", () => {
  const rows = byName(parseTrx(serializeTrx([
    { name: "a", status: "pass", durationMs: 42 },
    { name: "b", status: "fail", durationMs: 1234, message: "Expected 401 but got 200" },
  ])));
  assert.equal(rows.a.durationMs, 42);
  assert.equal(rows.b.durationMs, 1234);
  assert.equal(rows.b.message, "Expected 401 but got 200");
  // serializeTrx stamps a fixed class name that parseTrx recovers from the definitions.
  assert.equal(rows.a.className, "Mock.Tests");
});

test("parseTrx maps TRX outcomes to pass/fail/skip", () => {
  const xml = `<?xml version="1.0"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testName="err" outcome="Error" testId="t1" />
    <UnitTestResult testName="timeout" outcome="Timeout" testId="t2" />
    <UnitTestResult testName="inconclusive" outcome="Inconclusive" testId="t3" />
    <UnitTestResult testName="passed" outcome="Passed" testId="t4" />
  </Results>
</TestRun>`;
  const rows = byName(parseTrx(xml));
  assert.equal(rows.err.status, "fail");
  assert.equal(rows.timeout.status, "fail");
  assert.equal(rows.inconclusive.status, "skip");
  assert.equal(rows.passed.status, "pass");
});

test("parseTrx joins Message and StackTrace into one message", () => {
  const xml = `<?xml version="1.0"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testName="x" outcome="Failed" testId="t1">
      <Output><ErrorInfo><Message>boom</Message><StackTrace>at foo (a.cs:10)</StackTrace></ErrorInfo></Output>
    </UnitTestResult>
  </Results>
</TestRun>`;
  const [row] = parseTrx(xml);
  assert.equal(row.message, "boom\nat foo (a.cs:10)");
});

test("TRX round-trip preserves XML-special characters", () => {
  const [row] = parseTrx(serializeTrx([
    { name: 'a & b <c>', status: "fail", message: 'x < y & "z"' },
  ]));
  assert.equal(row.name, "a & b <c>");
  assert.equal(row.message, 'x < y & "z"');
});

test("parseTrx returns an empty array for empty or junk input", () => {
  assert.deepEqual(parseTrx(""), []);
  assert.deepEqual(parseTrx("<TestRun></TestRun>"), []);
});
