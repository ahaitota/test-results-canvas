// Unit tests for the JUnit XML parser.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJUnit } from "../junit.mjs";

const byName = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));

const SUITE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="auth" timestamp="2024-01-01T10:00:00" hostname="ci-box">
    <testcase name="passes" classname="Auth.Login" time="0.042" />
    <testcase name="fails" classname="Auth.Token" time="0.015">
      <failure message="Expected 401" type="AssertionError">at token.test.js:57</failure>
    </testcase>
    <testcase name="errors" classname="Auth.Boom" time="0.02">
      <error message="Boom" type="RuntimeError">stack here</error>
    </testcase>
    <testcase name="skips" classname="Auth.Flaky" time="0">
      <skipped message="flaky env" />
    </testcase>
  </testsuite>
</testsuites>`;

test("parseJUnit maps pass/fail/error/skip outcomes", () => {
  const rows = byName(parseJUnit(SUITE));
  assert.equal(Object.keys(rows).length, 4);
  assert.equal(rows.passes.status, "pass");
  assert.equal(rows.fails.status, "fail");
  assert.equal(rows.errors.status, "fail"); // <error> also counts as a failure
  assert.equal(rows.skips.status, "skip");
});

test("parseJUnit converts time (seconds) to durationMs", () => {
  const rows = byName(parseJUnit(SUITE));
  assert.equal(rows.passes.durationMs, 42);
  assert.equal(rows.fails.durationMs, 15);
  assert.equal(rows.errors.durationMs, 20);
  assert.equal(rows.skips.durationMs, 0);
});

test("parseJUnit attaches suite context to each case", () => {
  const rows = byName(parseJUnit(SUITE));
  assert.equal(rows.passes.className, "Auth.Login");
  assert.equal(rows.passes.suite, "auth");
  assert.equal(rows.passes.startTime, "2024-01-01T10:00:00");
  assert.equal(rows.passes.computerName, "ci-box");
  assert.equal(rows.passes.method, "passes");
});

test("parseJUnit builds failure and error messages from type + message + body", () => {
  const rows = byName(parseJUnit(SUITE));
  assert.equal(rows.fails.message, "AssertionError: Expected 401\nat token.test.js:57");
  assert.equal(rows.errors.message, "RuntimeError: Boom\nstack here");
});

test("parseJUnit uses the skipped message and leaves passes without a message", () => {
  const rows = byName(parseJUnit(SUITE));
  assert.equal(rows.skips.message, "flaky env");
  assert.equal(rows.passes.message, undefined);
});

test("parseJUnit handles bare testcases with no testsuite wrapper", () => {
  const rows = parseJUnit(`<testcase name="lonely" classname="X" time="0.1" />`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "pass");
  assert.equal(rows[0].durationMs, 100);
});

test("parseJUnit unescapes XML entities in messages", () => {
  const rows = parseJUnit(
    `<testsuite name="s"><testcase name="x">` +
    `<failure message="a &lt; b &amp; c">stack &gt; here</failure>` +
    `</testcase></testsuite>`
  );
  assert.equal(rows[0].message, "a < b & c\nstack > here");
});

test("parseJUnit leaves durationMs undefined when time is absent", () => {
  const rows = parseJUnit(`<testsuite name="s"><testcase name="x" classname="X" /></testsuite>`);
  assert.equal(rows[0].durationMs, undefined);
});

test("parseJUnit returns an empty array for empty input", () => {
  assert.deepEqual(parseJUnit(""), []);
});
