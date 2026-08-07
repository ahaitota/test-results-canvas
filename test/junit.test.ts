// Unit tests for the JUnit XML parser.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJUnit } from "../src/parsers/junit.js";
import type { TestResult } from "../src/types.js";

const byName = (rows: TestResult[]) => Object.fromEntries(rows.map((r) => [r.name, r]));

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

// --- Nested <testsuite> handling (issue #2) ------------------------------

// The exact reproduction from the issue: an inner suite followed by a sibling
// case in the outer suite. The old single-regex parser dropped `outerTest`
// and mislabelled `innerTest` as belonging to "Outer".
const NESTED = `<testsuites>
  <testsuite name="Outer">
    <testsuite name="Inner">
      <testcase name="innerTest" classname="Inner" time="0.01"/>
    </testsuite>
    <testcase name="outerTest" classname="Outer" time="0.02"/>
  </testsuite>
</testsuites>`;

test("parseJUnit keeps every case in nested suites and uses the nearest suite name", () => {
  const rows = byName(parseJUnit(NESTED));
  assert.equal(Object.keys(rows).length, 2); // nothing silently dropped
  assert.equal(rows.innerTest.suite, "Inner");
  assert.equal(rows.outerTest.suite, "Outer");
});

test("parseJUnit reports correct status and suite context for nested cases", () => {
  const xml = `<testsuite name="Outer" timestamp="2024-01-01" hostname="outer-host">
      <testsuite name="Inner" timestamp="2025-02-02" hostname="inner-host">
        <testcase name="innerFail" time="0.01">
          <failure message="nope" type="AssertionError">at inner.js:1</failure>
        </testcase>
      </testsuite>
      <testcase name="outerPass" time="0.02"/>
    </testsuite>`;
  const rows = byName(parseJUnit(xml));
  assert.equal(Object.keys(rows).length, 2);
  assert.equal(rows.innerFail.status, "fail");
  assert.equal(rows.innerFail.suite, "Inner");
  assert.equal(rows.innerFail.startTime, "2025-02-02");
  assert.equal(rows.innerFail.computerName, "inner-host");
  assert.equal(rows.outerPass.status, "pass");
  assert.equal(rows.outerPass.suite, "Outer");
  assert.equal(rows.outerPass.startTime, "2024-01-01");
});

test("parseJUnit handles suites nested three levels deep with interleaved cases", () => {
  const xml = `<testsuite name="L1">
      <testcase name="a"/>
      <testsuite name="L2">
        <testcase name="b"/>
        <testsuite name="L3">
          <testcase name="c"/>
        </testsuite>
        <testcase name="b2"/>
      </testsuite>
      <testcase name="a2"/>
    </testsuite>`;
  const rows = byName(parseJUnit(xml));
  assert.deepEqual(Object.keys(rows).sort(), ["a", "a2", "b", "b2", "c"]);
  assert.equal(rows.a.suite, "L1");
  assert.equal(rows.a2.suite, "L1");
  assert.equal(rows.b.suite, "L2");
  assert.equal(rows.b2.suite, "L2");
  assert.equal(rows.c.suite, "L3");
});

test("parseJUnit still attributes sibling (non-nested) suites correctly", () => {
  const xml = `<testsuites>
      <testsuite name="A"><testcase name="a1"/></testsuite>
      <testsuite name="B"><testcase name="b1"/></testsuite>
    </testsuites>`;
  const rows = byName(parseJUnit(xml));
  assert.equal(Object.keys(rows).length, 2);
  assert.equal(rows.a1.suite, "A");
  assert.equal(rows.b1.suite, "B");
});

test("parseJUnit tolerates self-closed testsuite elements", () => {
  const xml = `<testsuites>
      <testsuite name="Empty" tests="0"/>
      <testsuite name="Real"><testcase name="r1"/></testsuite>
    </testsuites>`;
  const rows = byName(parseJUnit(xml));
  assert.equal(Object.keys(rows).length, 1);
  assert.equal(rows.r1.suite, "Real");
});

test("parseJUnit captures a testcase that sits outside any suite", () => {
  const xml = `<testsuites>
      <testcase name="loose"/>
      <testsuite name="S"><testcase name="inside"/></testsuite>
    </testsuites>`;
  const rows = byName(parseJUnit(xml));
  assert.equal(Object.keys(rows).length, 2);
  assert.equal(rows.loose.suite, undefined);
  assert.equal(rows.inside.suite, "S");
});

// --- XML-aware scanning: whitespace, comments, CDATA (issue #2 review) -----

test("parseJUnit tolerates whitespace before '>' in a closing testsuite tag", () => {
  // Inner suite closed with "</testsuite >"; the outer case must be Outer.
  const xml =
    `<testsuite name="Outer"><testsuite name="Inner">` +
    `<testcase name="inner"/></testsuite ><testcase name="outer"/></testsuite>`;
  const rows = byName(parseJUnit(xml));
  assert.equal(rows.inner.suite, "Inner");
  assert.equal(rows.outer.suite, "Outer");
});

test("parseJUnit ignores suite-like text inside XML comments", () => {
  // A commented-out <testsuite> must not push a phantom suite.
  const xml =
    `<testsuite name="Real"><!-- <testsuite name="Fake"> -->` +
    `<testcase name="a"/></testsuite><testcase name="b"/>`;
  const rows = byName(parseJUnit(xml));
  assert.equal(rows.a.suite, "Real");
  assert.equal(rows.b.suite, undefined);
});

test("parseJUnit ignores suite/case-like text inside CDATA", () => {
  // "</testcase>" / "<testsuite>" inside CDATA is literal text, not markup.
  const xml =
    `<testsuite name="Real">` +
    `<testcase name="a"><failure><![CDATA[boom </testcase> <testsuite name="Fake">]]></failure></testcase>` +
    `<testcase name="b"/></testsuite>`;
  const rows = byName(parseJUnit(xml));
  assert.equal(Object.keys(rows).length, 2);
  assert.equal(rows.a.status, "fail");
  assert.equal(rows.a.suite, "Real");
  assert.equal(rows.b.status, "pass");
  assert.equal(rows.b.suite, "Real");
});

// --- ">" is legal inside an attribute value ------------------------------
// Only "<" and "&" must be escaped in XML, so runners emit a bare ">" in names
// and failure messages. Ending a tag at the first ">" dropped the case and, since
// the truncated stub no longer looked self-closing, swallowed the rest of the file.

test("parseJUnit keeps a testcase whose name contains a raw '>'", () => {
  const xml = `<testsuite name="s"><testcase name="tolerates '>' in a tag" time="0.001"/></testsuite>`;
  const rows = parseJUnit(xml);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "tolerates '>' in a tag");
  assert.equal(rows[0].status, "pass");
  assert.equal(rows[0].suite, "s");
});

test("a raw '>' in one testcase does not swallow the cases after it", () => {
  const xml =
    `<testsuite name="s">` +
    `<testcase name="has > inside"/>` +
    `<testcase name="later fail"><failure message="nope">stack</failure></testcase>` +
    `<testcase name="last"/>` +
    `</testsuite>`;
  const rows = byName(parseJUnit(xml));
  assert.deepEqual(Object.keys(rows).sort(), ["has > inside", "last", "later fail"]);
  assert.equal(rows["later fail"].status, "fail");
  assert.equal(rows.last.status, "pass");
});

test("parseJUnit keeps a failure message that contains a raw '>'", () => {
  const xml =
    `<testsuite name="s"><testcase name="x">` +
    `<failure message="Expected List&lt;int> but was List&lt;string>" type="AssertionError">at x.ts:1</failure>` +
    `</testcase></testsuite>`;
  const rows = parseJUnit(xml);
  assert.equal(rows[0].status, "fail");
  assert.match(rows[0].message ?? "", /Expected List<int> but was List<string>/);
  assert.match(rows[0].message ?? "", /at x\.ts:1/);
});

test("parseJUnit handles single-quoted attribute values containing '>'", () => {
  const xml = `<testsuite name='a > b'><testcase name='c > d' time='0.5'/></testsuite>`;
  const rows = parseJUnit(xml);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].durationMs, 500);
});
