// Unit tests for the cross-language result parsers (issue #26).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNUnit } from "../src/parsers/nunit.js";
import { parseXunit } from "../src/parsers/xunit.js";
import { parseTestNG } from "../src/parsers/testng.js";
import { parseCTest } from "../src/parsers/ctest.js";
import { parseTap } from "../src/parsers/tap.js";
import { parseCtrf } from "../src/parsers/ctrf.js";
import { parseAllure } from "../src/parsers/allure.js";
import { parseGoTest } from "../src/parsers/gotest.js";
import { parseDart } from "../src/parsers/dart.js";
import { parseRustJson } from "../src/parsers/rust.js";
import type { TestResult } from "../src/types.js";

const byName = (rows: TestResult[]) => Object.fromEntries(rows.map((r) => [r.name, r]));
const statuses = (rows: TestResult[]) => rows.map((r) => r.status);

// --- NUnit 3 ---------------------------------------------------------------

const NUNIT = `<?xml version="1.0" encoding="utf-8"?>
<test-run id="2" testcasecount="3" result="Failed" duration="0.5">
  <test-suite type="Assembly" name="Sample.dll">
    <test-suite type="TestFixture" name="CalcTests">
      <test-case name="Adds" methodname="Adds" classname="Ns.CalcTests" result="Passed" duration="0.042"
                 start-time="2024-01-01 10:00:01Z" end-time="2024-01-01 10:00:02Z" />
      <test-case name="Subtracts" methodname="Subtracts" classname="Ns.CalcTests" result="Failed" duration="0.015">
        <failure>
          <message><![CDATA[Expected 1 but was 2]]></message>
          <stack-trace><![CDATA[at Ns.CalcTests.Subtracts()]]></stack-trace>
        </failure>
      </test-case>
      <test-case name="Divides" classname="Ns.CalcTests" result="Skipped" label="Ignored" duration="0">
        <reason><message>not ready</message></reason>
      </test-case>
    </test-suite>
  </test-suite>
</test-run>`;

test("parseNUnit maps outcomes, durations, suite and failure detail", () => {
  const rows = parseNUnit(NUNIT);
  assert.deepEqual(statuses(rows), ["pass", "fail", "skip"]);
  const by = byName(rows);
  assert.equal(by.Adds.durationMs, 42);
  assert.equal(by.Adds.suite, "CalcTests");
  assert.equal(by.Adds.className, "Ns.CalcTests");
  assert.equal(by.Adds.startTime, "2024-01-01 10:00:01Z");
  assert.equal(by.Subtracts.message, "Expected 1 but was 2\nat Ns.CalcTests.Subtracts()");
  assert.equal(by.Divides.message, "not ready");
});

test("parseNUnit reports a suite that failed with no case to show it", () => {
  // OneTimeSetUp blows up: the fixture carries the failure and its tests never
  // ran, so without this the run renders as empty and green.
  const rows = parseNUnit(`<test-run id="1" result="Failed">
  <test-suite type="Assembly" name="Sample.dll" result="Failed">
    <test-suite type="TestFixture" name="CalcTests" result="Failed" duration="0.2">
      <failure>
        <message><![CDATA[OneTimeSetUp: connection refused]]></message>
        <stack-trace><![CDATA[at Ns.CalcTests.Setup()]]></stack-trace>
      </failure>
    </test-suite>
  </test-suite>
</test-run>`);
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["CalcTests", "fail"]]);
  assert.equal(rows[0].message, "OneTimeSetUp: connection refused\nat Ns.CalcTests.Setup()");
  assert.equal(rows[0].suite, "Sample.dll");
});

test("parseNUnit reports a teardown failure alongside the case that already failed", () => {
  // OneTimeTearDown fails independently of the test, and its diagnostics exist
  // nowhere else in the report.
  const rows = parseNUnit(`<test-run id="1" result="Failed">
  <test-suite type="TestFixture" name="CalcTests" result="Failed" site="TearDown">
    <failure>
      <message><![CDATA[OneTimeTearDown: the connection was already closed]]></message>
    </failure>
    <test-case name="Subtracts" result="Failed"><failure><message>assertion</message></failure></test-case>
  </test-suite>
</test-run>`);
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["Subtracts", "fail"], ["CalcTests", "fail"]]);
  assert.equal(rows[1].message, "OneTimeTearDown: the connection was already closed");
});

test("parseNUnit does not repeat a suite failure its cases already report", () => {
  // site="Child" is NUnit's aggregate roll-up: the cases beneath already say it.
  const rows = parseNUnit(`<test-run id="1" result="Failed">
  <test-suite type="TestFixture" name="CalcTests" result="Failed" site="Child">
    <failure><message>One or more child tests had errors</message></failure>
    <test-case name="Subtracts" result="Failed"><failure><message>boom</message></failure></test-case>
  </test-suite>
</test-run>`);
  assert.deepEqual(rows.map((r) => r.name), ["Subtracts"]);
});

test("parseNUnit reports a parent fixture failure once, not on every child it took down", () => {
  // NUnit copies the failure onto each affected suite with site="Parent"; only
  // the suite whose own SetUp failed owns it.
  const rows = parseNUnit(`<test-run id="1" result="Failed">
  <test-suite type="SetUpFixture" name="Database" result="Failed" site="SetUp">
    <failure>
      <message><![CDATA[OneTimeSetUp: connection refused]]></message>
    </failure>
    <test-suite type="TestFixture" name="CalcTests" result="Failed" site="Parent">
      <failure><message><![CDATA[OneTimeSetUp: connection refused]]></message></failure>
    </test-suite>
    <test-suite type="TestFixture" name="OrderTests" result="Failed" site="Parent">
      <failure><message><![CDATA[OneTimeSetUp: connection refused]]></message></failure>
    </test-suite>
  </test-suite>
</test-run>`);
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["Database", "fail"]]);
  assert.equal(rows[0].message, "OneTimeSetUp: connection refused");
});

test("parseNUnit reports a run that failed before any suite did", () => {
  // An assembly that will not load produces no suite to hang the failure on,
  // and an empty run would read as green.
  const rows = parseNUnit(`<test-run id="1" name="Sample.dll" result="Failed" testcasecount="0">
  <failure><message><![CDATA[Could not load file or assembly]]></message></failure>
</test-run>`);
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["Sample.dll", "fail"]]);
  assert.equal(rows[0].message, "Could not load file or assembly");
});

test("parseNUnit reads NUnit 2 result/time spellings", () => {
  const rows = parseNUnit(`<test-results><test-suite name="Old"><results>
    <test-case name="Legacy" result="Success" time="0.100" />
  </results></test-suite></test-results>`);
  assert.deepEqual(statuses(rows), ["pass"]);
  assert.equal(rows[0].durationMs, 100);
});

test("parseNUnit returns nothing for an empty run", () => {
  assert.deepEqual(parseNUnit(`<test-run id="1" testcasecount="0" />`), []);
});

// --- xUnit.net -------------------------------------------------------------

const XUNIT = `<assemblies>
  <assembly name="/src/Sample.dll" run-date="2024-01-01" run-time="10:00:00" total="3">
    <collection name="Test collection for Ns.CalcTests" time="0.1">
      <test name="Ns.CalcTests.Adds" type="Ns.CalcTests" method="Adds" time="0.042" result="Pass" />
      <test name="Ns.CalcTests.Subtracts" type="Ns.CalcTests" method="Subtracts" time="0.015" result="Fail">
        <failure exception-type="Xunit.Sdk.EqualException">
          <message><![CDATA[Assert.Equal() Failure]]></message>
          <stack-trace><![CDATA[at Ns.CalcTests.Subtracts()]]></stack-trace>
        </failure>
      </test>
      <test name="Ns.CalcTests.Divides" type="Ns.CalcTests" method="Divides" time="0" result="Skip">
        <reason><![CDATA[not ready]]></reason>
      </test>
    </collection>
  </assembly>
</assemblies>`;

test("parseXunit maps outcomes and carries assembly/collection context", () => {
  const rows = parseXunit(XUNIT);
  assert.deepEqual(statuses(rows), ["pass", "fail", "skip"]);
  assert.equal(rows[0].durationMs, 42);
  assert.equal(rows[0].method, "Adds");
  assert.equal(rows[0].className, "Ns.CalcTests");
  assert.equal(rows[0].suite, "Test collection for Ns.CalcTests");
  assert.equal(rows[0].storage, "/src/Sample.dll");
  assert.equal(rows[0].startTime, "2024-01-01T10:00:00");
  assert.equal(rows[1].message, "Assert.Equal() Failure\nat Ns.CalcTests.Subtracts()");
  assert.equal(rows[2].message, "not ready");
});

test("parseXunit reads the v3 per-test source path and timestamps", () => {
  const rows = parseXunit(`<assemblies>
  <assembly name="/src/Sample.dll" run-date="2024-01-01" run-time="10:00:00">
    <collection name="c">
      <test name="Ns.CalcTests.Adds" type="Ns.CalcTests" method="Adds" time="0.042" result="Pass"
            source-file="/src/CalcTests.cs" source-line="12"
            start-rtf="2024-01-01T10:00:05.0000000+00:00" finish-rtf="2024-01-01T10:00:05.0420000+00:00" />
      <test name="Ns.CalcTests.Legacy" type="Ns.CalcTests" method="Legacy" time="0.01" result="Pass" />
    </collection>
  </assembly>
</assemblies>`);
  assert.equal(rows[0].file, "/src/CalcTests.cs");
  assert.equal(rows[0].startTime, "2024-01-01T10:00:05.0000000+00:00");
  assert.equal(rows[0].endTime, "2024-01-01T10:00:05.0420000+00:00");
  // v2 wrote no per-test times, so the assembly's stay the fallback.
  assert.equal(rows[1].startTime, "2024-01-01T10:00:00");
  assert.equal(rows[1].endTime, undefined);
  assert.equal(rows[1].file, undefined);
});

test("parseXunit reports assembly-level errors, which no collection holds", () => {
  // Fixture and assembly cleanup fail outside every collection; without this
  // the report parses to nothing at all.
  const rows = parseXunit(`<assemblies>
  <assembly name="/src/Sample.dll" errors="1" total="0">
    <errors>
      <error type="fixture-cleanup" name="Ns.DatabaseFixture">
        <failure exception-type="System.InvalidOperationException">
          <message><![CDATA[the connection was already closed]]></message>
          <stack-trace><![CDATA[at Ns.DatabaseFixture.Dispose()]]></stack-trace>
        </failure>
      </error>
    </errors>
  </assembly>
</assemblies>`);
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["Ns.DatabaseFixture", "fail"]]);
  assert.equal(rows[0].message, "System.InvalidOperationException\nthe connection was already closed\nat Ns.DatabaseFixture.Dispose()");
  assert.equal(rows[0].storage, "/src/Sample.dll");
});

test("parseXunit returns nothing for an assembly that ran no tests", () => {
  assert.deepEqual(parseXunit(`<assemblies><assembly name="x.dll" total="0" /></assemblies>`), []);
});

// --- TestNG ----------------------------------------------------------------

const TESTNG = `<testng-results skipped="1" failed="1" total="3" passed="1">
  <suite name="Default suite" duration-ms="100" started-at="2024-01-01T10:00:00Z">
    <test name="Default test">
      <class name="com.example.CalcTest">
        <test-method status="PASS" name="adds" duration-ms="42"
                     started-at="2024-01-01T10:00:00Z" finished-at="2024-01-01T10:00:01Z" />
        <test-method status="PASS" is-config="true" name="setUp" duration-ms="1" />
        <test-method status="FAIL" name="subtracts" duration-ms="15">
          <exception class="java.lang.AssertionError">
            <message><![CDATA[expected [1] but found [2]]]></message>
            <full-stacktrace><![CDATA[at com.example.CalcTest.subtracts]]></full-stacktrace>
          </exception>
        </test-method>
        <test-method status="SKIP" name="divides" duration-ms="0" />
      </class>
    </test>
  </suite>
</testng-results>`;

test("parseTestNG skips configuration methods and keeps class/suite context", () => {
  const rows = parseTestNG(TESTNG);
  assert.deepEqual(rows.map((r) => r.name), ["adds", "subtracts", "divides"]);
  assert.deepEqual(statuses(rows), ["pass", "fail", "skip"]);
  assert.equal(rows[0].durationMs, 42);
  assert.equal(rows[0].className, "com.example.CalcTest");
  assert.equal(rows[0].suite, "Default suite");
  assert.equal(rows[0].endTime, "2024-01-01T10:00:01Z");
  assert.equal(rows[1].message, "java.lang.AssertionError\nexpected [1] but found [2]\nat com.example.CalcTest.subtracts");
});

test("parseTestNG keeps a failed configuration method, which is the run's real failure", () => {
  const rows = parseTestNG(`<testng-results total="2">
  <suite name="Default suite">
    <test name="Default test">
      <class name="com.example.CalcTest">
        <test-method status="FAIL" is-config="true" name="setUp" duration-ms="3">
          <exception class="java.lang.IllegalStateException">
            <message><![CDATA[setup failed]]></message>
          </exception>
        </test-method>
        <test-method status="SKIP" is-config="true" name="tearDown" duration-ms="0" />
        <test-method status="SKIP" name="adds" duration-ms="0" />
      </class>
    </test>
  </suite>
</testng-results>`);
  // The skipped teardown is configuration TestNG abandoned after the setup
  // failed; counting it would inflate the run.
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["setUp", "fail"], ["adds", "skip"]]);
  assert.equal(rows[0].message, "java.lang.IllegalStateException\nsetup failed");
});

test("parseTestNG returns nothing for a run with no methods", () => {
  assert.deepEqual(parseTestNG(`<testng-results total="0"><suite name="s" /></testng-results>`), []);
});

// --- CTest -----------------------------------------------------------------

const CTEST = `<?xml version="1.0" encoding="UTF-8"?>
<Site BuildName="Linux" Name="ci-box">
  <Testing>
    <StartDateTime>Jan 01 10:00 UTC</StartDateTime>
    <TestList>
      <Test>./calc/adds</Test>
      <Test>./calc/subtracts</Test>
    </TestList>
    <Test Status="passed">
      <Name>adds</Name><Path>./calc</Path>
      <Results><NamedMeasurement type="numeric/double" name="Execution Time"><Value>0.042</Value></NamedMeasurement></Results>
    </Test>
    <Test Status="failed">
      <Name>subtracts</Name><Path>./calc</Path>
      <Results>
        <NamedMeasurement type="numeric/double" name="Execution Time"><Value>0.015</Value></NamedMeasurement>
        <NamedMeasurement type="text/string" name="Exception"><Value>SegFault</Value></NamedMeasurement>
        <Measurement><Value>assertion failed</Value></Measurement>
      </Results>
    </Test>
    <Test Status="notrun"><Name>divides</Name><Path>./calc</Path></Test>
  </Testing>
</Site>`;

test("parseCTest reads outcomes and ignores the TestList entries", () => {
  const rows = parseCTest(CTEST);
  assert.deepEqual(rows.map((r) => r.name), ["adds", "subtracts", "divides"]);
  assert.deepEqual(statuses(rows), ["pass", "fail", "skip"]);
  assert.equal(rows[0].durationMs, 42);
  assert.equal(rows[0].suite, "./calc");
  assert.equal(rows[0].startTime, "Jan 01 10:00 UTC");
  assert.equal(rows[0].message, undefined);
  assert.equal(rows[1].message, "SegFault\nassertion failed");
});

test("parseCTest returns nothing when no test ran", () => {
  assert.deepEqual(parseCTest(`<Site><Testing><TestList /></Testing></Site>`), []);
});

// --- TAP 13 ----------------------------------------------------------------

const TAP = `TAP version 13
1..4
ok 1 - adds
not ok 2 - subtracts
  ---
  duration_ms: 15
  error: 'Expected 1 got 2'
  ...
ok 3 - divides # SKIP not ready
ok 4 - stubbed # TODO write it
`;

test("parseTap reads points, directives and the YAML diagnostic block", () => {
  const rows = parseTap(TAP);
  assert.deepEqual(rows.map((r) => r.name), ["adds", "subtracts", "divides", "stubbed"]);
  assert.deepEqual(statuses(rows), ["pass", "fail", "skip", "skip"]);
  assert.equal(rows[1].message, "Expected 1 got 2");
  assert.equal(rows[1].durationMs, 15);
  assert.equal(rows[2].message, "not ready");
});

test("parseTap treats a bare Subtest annotation as a label, not a nested stream", () => {
  // What `node --test --test-reporter=tap` writes for a single top-level test:
  // the annotation sits directly above the point that summarises it.
  const rows = parseTap("TAP version 13\n# Subtest: simple\nok 1 - simple\n1..1\n");
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["simple", "pass"]]);
});

test("parseTap nests subtests under the parent point", () => {
  const rows = parseTap(`TAP version 13
# Subtest: calc
    ok 1 - adds
    not ok 2 - subtracts
    1..2
ok 1 - calc
1..1
`);
  assert.deepEqual(rows.map((r) => [r.name, r.suite]), [["adds", "calc"], ["subtracts", "calc"], ["calc", undefined]]);
});

test("parseTap reads a multi-line YAML block scalar, which is what node:test emits", () => {
  const rows = parseTap(`TAP version 13
not ok 1 - subtracts two numbers
  ---
  duration_ms: 1.7
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    1 !== 2
  code: 'ERR_ASSERTION'
  stack: |-
    TestContext.<anonymous> (calc.test.js:5:3)
  ...
1..1
`);
  assert.equal(rows[0].status, "fail");
  assert.equal(rows[0].durationMs, 2);
  assert.equal(rows[0].message, "Expected values to be strictly equal:\n\n1 !== 2\nTestContext.<anonymous> (calc.test.js:5:3)");
});

test("parseTap reports a bail out as a failure and stops reading points", () => {
  const rows = parseTap(`TAP version 13
ok 1 - connected
Bail out! database unavailable
ok 2 - never ran
`);
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["connected", "pass"], ["Bail out!", "fail"]]);
  assert.equal(rows[1].message, "database unavailable");
});

test("parseTap fails a stream that ends short of its plan", () => {
  const rows = parseTap("TAP version 13\n1..2\nok 1 - first\n");
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["first", "pass"], ["TAP stream not valid", "fail"]]);
  assert.equal(rows[1].message, "TAP plan expected 2 tests, saw 1");
});

test("parseTap fails a stream that never declared a plan", () => {
  const rows = parseTap("TAP version 13\nok 1 - first\n");
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["first", "pass"], ["TAP stream not valid", "fail"]]);
  assert.equal(rows[1].message, "TAP stream declared no 1..N plan");
});

test("parseTap fails a stream that declared two plans", () => {
  const rows = parseTap("TAP version 13\n1..1\nok 1 - first\n1..1\n");
  assert.equal(rows[1].message, "TAP stream declared more than one 1..N plan");
});

test("parseTap validates point numbers against a plan that trails them", () => {
  // The count matches the plan, so only the numbering shows that point 1 never
  // arrived -- and the plan is not known until after both points are read.
  const rows = parseTap("TAP version 13\nok 2 - second\nok 3 - third\n1..2\n");
  assert.deepEqual(rows.map((r) => r.status), ["pass", "pass", "fail"]);
  assert.equal(rows[2].message, "TAP point 3 falls outside the plan 1..2");
});

test("parseTap fails repeated or out-of-order point numbers", () => {
  // The count matches the plan, so only the numbering shows that a result was
  // lost.
  const rows = parseTap("TAP version 13\n1..2\nok 1 - first\nok 1 - duplicate\n");
  assert.deepEqual(rows.map((r) => r.status), ["pass", "pass", "fail"]);
  assert.equal(rows[2].message, "TAP point 1 repeats or follows a higher number");
});

test("parseTap fails a point numbered outside its plan", () => {
  const rows = parseTap("TAP version 13\n1..2\nok 1 - first\nok 5 - stray\n");
  assert.equal(rows[2].message, "TAP point 5 falls outside the plan 1..2");
});

test("parseTap reports an unmet plan against the subtest that owns it", () => {
  const rows = parseTap(`TAP version 13
# Subtest: calc
    ok 1 - adds
    1..2
ok 1 - calc
1..1
`);
  assert.deepEqual(rows.map((r) => [r.name, r.suite]), [["adds", "calc"], ["TAP stream not valid", "calc"], ["calc", undefined]]);
});

test("parseTap leaves a bail out to speak for the tests that never ran", () => {
  const rows = parseTap("TAP version 13\n1..3\nok 1 - connected\nBail out! database unavailable\n");
  assert.deepEqual(rows.map((r) => r.name), ["connected", "Bail out!"]);
});

test("parseTap returns nothing for a plan with no points", () => {
  assert.deepEqual(parseTap("TAP version 13\n1..0 # no tests\n"), []);
});

// --- CTRF ------------------------------------------------------------------

const CTRF = JSON.stringify({
  reportFormat: "CTRF",
  specVersion: "0.0.0",
  results: {
    tool: { name: "jest" },
    summary: { tests: 3, passed: 1, failed: 1, skipped: 1 },
    tests: [
      { name: "adds", status: "passed", duration: 42, suite: "calc", filePath: "src/calc.test.ts", start: 1704103200000, stop: 1704103200042 },
      { name: "subtracts", status: "failed", duration: 15, message: "Expected 1 got 2", trace: "at calc.test.ts:5" },
      { name: "divides", status: "skipped", duration: 0 },
    ],
  },
});

test("parseCtrf maps tests, tool name and epoch timestamps", () => {
  const rows = parseCtrf(CTRF);
  assert.deepEqual(statuses(rows), ["pass", "fail", "skip"]);
  assert.equal(rows[0].durationMs, 42);
  assert.equal(rows[0].framework, "jest");
  assert.equal(rows[0].suite, "calc");
  assert.equal(rows[0].file, "src/calc.test.ts");
  assert.equal(rows[0].startTime, "2024-01-01T10:00:00.000Z");
  assert.equal(rows[1].message, "Expected 1 got 2\nat calc.test.ts:5");
});

test("parseCtrf rejects a test record without a name or a known status", () => {
  // A failed record missing its name would silently drop out, so a report
  // declaring one pass and one failure would render only the pass.
  const report = (tests: string) => `{"reportFormat":"CTRF","results":{"tool":{"name":"jest"},"tests":[${tests}]}}`;
  assert.throws(() => parseCtrf(report(`{"name":"adds","status":"passed"},{"status":"failed","message":"boom"}`)));
  assert.throws(() => parseCtrf(report(`{"name":"adds","status":"exploded"}`)));
});

test("parseCtrf rejects a report whose summary counts more tests than it holds", () => {
  assert.throws(() => parseCtrf(`{"reportFormat":"CTRF","results":{"tool":{"name":"jest"},"summary":{"tests":2,"passed":1,"failed":1},"tests":[{"name":"adds","status":"passed"}]}}`));
});

test("parseCtrf rejects a report with no results.tests array", () => {
  // reportFormat already claimed the file as CTRF, so these are malformed
  // reports, not runs in which nothing happened.
  assert.throws(() => parseCtrf(`{"reportFormat":"CTRF"}`));
  assert.throws(() => parseCtrf(`{"reportFormat":"CTRF","results":{}}`));
  assert.throws(() => parseCtrf(`{"reportFormat":"CTRF","results":{"tests":{}}}`));
  assert.throws(() => parseCtrf(`{"reportFormat":"CTRF","results":[]}`));
});

test("parseCtrf returns nothing for a report with no tests", () => {
  assert.deepEqual(parseCtrf(`{"reportFormat":"CTRF","results":{"tests":[]}}`), []);
});

test("parseCtrf throws on malformed JSON so the registry can reject the file", () => {
  assert.throws(() => parseCtrf(`{"results":{"tests":[`));
});

// --- Allure 2 --------------------------------------------------------------

const ALLURE = JSON.stringify({
  uuid: "a1",
  historyId: "h1",
  name: "subtracts",
  fullName: "com.example.CalcTest.subtracts",
  status: "failed",
  statusDetails: { message: "expected 1", trace: "at CalcTest.java:12" },
  start: 1704103200000,
  stop: 1704103200150,
  labels: [
    { name: "suite", value: "CalcTest" },
    { name: "testClass", value: "com.example.CalcTest" },
    { name: "framework", value: "junit4" },
  ],
});

test("parseAllure derives duration from start/stop and reads labels", () => {
  const [row] = parseAllure(ALLURE);
  assert.equal(row.status, "fail");
  assert.equal(row.durationMs, 150);
  assert.equal(row.suite, "CalcTest");
  assert.equal(row.className, "com.example.CalcTest");
  assert.equal(row.framework, "junit4");
  assert.equal(row.message, "expected 1\nat CalcTest.java:12");
});

test("parseAllure treats broken as a failure and unknown as a skip", () => {
  const rows = parseAllure(JSON.stringify([
    { uuid: "b", name: "broke", status: "broken" },
    { uuid: "c", name: "unclear", status: "unknown" },
    { uuid: "d", name: "ok", status: "passed" },
  ]));
  assert.deepEqual(statuses(rows), ["fail", "skip", "pass"]);
});

// --- go test -json ---------------------------------------------------------

const GO = [
  { Time: "2024-01-01T10:00:00Z", Action: "run", Package: "example/calc", Test: "TestAdds" },
  { Time: "2024-01-01T10:00:00Z", Action: "output", Package: "example/calc", Test: "TestAdds", Output: "=== RUN   TestAdds\n" },
  { Time: "2024-01-01T10:00:01Z", Action: "pass", Package: "example/calc", Test: "TestAdds", Elapsed: 0.042 },
  { Time: "2024-01-01T10:00:01Z", Action: "output", Package: "example/calc", Test: "TestSubtracts", Output: "calc_test.go:12: want 1 got 2\n" },
  { Time: "2024-01-01T10:00:01Z", Action: "fail", Package: "example/calc", Test: "TestSubtracts", Elapsed: 0.015 },
  { Time: "2024-01-01T10:00:01Z", Action: "skip", Package: "example/calc", Test: "TestDivides", Elapsed: 0 },
  { Time: "2024-01-01T10:00:01Z", Action: "fail", Package: "example/calc", Elapsed: 0.1 },
].map((e) => JSON.stringify(e)).join("\n");

test("parseGoTest folds events into one row per test and keeps package output", () => {
  const rows = parseGoTest(GO);
  assert.deepEqual(rows.map((r) => r.name), ["TestAdds", "TestSubtracts", "TestDivides"]);
  assert.deepEqual(statuses(rows), ["pass", "fail", "skip"]);
  assert.equal(rows[0].durationMs, 42);
  assert.equal(rows[0].suite, "example/calc");
  assert.equal(rows[0].message, undefined);
  assert.equal(rows[1].message, "calc_test.go:12: want 1 got 2");
});

test("parseGoTest ignores build noise interleaved with the event stream", () => {
  assert.deepEqual(parseGoTest("# example/calc\ncalc.go:3: syntax error\n"), []);
});

// --- Dart ------------------------------------------------------------------

const DART = [
  { protocolVersion: "0.1.1", runnerVersion: "1.24.0", pid: 1, type: "start", time: 0 },
  { type: "suite", suite: { id: 0, platform: "vm", path: "test/calc_test.dart" }, time: 1 },
  { type: "testStart", test: { id: 1, name: "loading test/calc_test.dart", suiteID: 0 }, time: 2 },
  { type: "testDone", testID: 1, result: "success", hidden: true, skipped: false, time: 3 },
  { type: "testStart", test: { id: 2, name: "calc adds", suiteID: 0 }, time: 10 },
  { type: "testDone", testID: 2, result: "success", hidden: false, skipped: false, time: 52 },
  { type: "testStart", test: { id: 3, name: "calc subtracts", suiteID: 0 }, time: 60 },
  { type: "error", testID: 3, error: "Expected: 1", stackTrace: "calc_test.dart 7:5", isFailure: true, time: 70 },
  { type: "testDone", testID: 3, result: "failure", hidden: false, skipped: false, time: 75 },
  { type: "testStart", test: { id: 4, name: "calc divides", suiteID: 0 }, time: 80 },
  { type: "testDone", testID: 4, result: "success", hidden: false, skipped: true, time: 80 },
  { type: "done", success: false, time: 90 },
].map((e) => JSON.stringify(e)).join("\n");

test("parseAllure rejects a record that is not a usable result", () => {
  // Structurally valid JSON, but nameless: it would contribute no row and no
  // error, quietly turning a failing run green.
  assert.throws(() => parseAllure(`{"uuid":"b","status":"failed"}`));
  assert.throws(() => parseAllure(`{"uuid":"b","name":"adds","status":"weird"}`));
  assert.throws(() => parseAllure(`{"name":"adds","status":"passed"}`));
});

test("parseGoTest keeps the run timestamp as the start and the terminal one as the end", () => {
  const [row] = parseGoTest(GO);
  assert.equal(row.startTime, "2024-01-01T10:00:00Z");
  assert.equal(row.endTime, "2024-01-01T10:00:01Z");
});

test("parseGoTest surfaces a package failure that no test reported", () => {
  // A build or TestMain failure has no Test to attach to, so dropping
  // package-level events hid the whole failed run.
  const rows = parseGoTest([
    { Action: "output", ImportPath: "example/calc", Output: "# example/calc\n" },
    { Action: "output", ImportPath: "example/calc", Output: "calc.go:3:2: undefined: missing\n" },
    { Time: "2024-01-01T10:00:00Z", Action: "fail", Package: "example/calc", Elapsed: 0.02, FailedBuild: "example/calc" },
  ].map((e) => JSON.stringify(e)).join("\n"));
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["example/calc", "fail"]]);
  assert.equal(rows[0].message, "# example/calc\ncalc.go:3:2: undefined: missing");
  assert.equal(rows[0].durationMs, 20);
});

test("parseGoTest does not double-report a package whose test already failed", () => {
  // The GO stream ends with a package-level fail, and TestSubtracts already
  // stands for it.
  assert.equal(parseGoTest(GO).filter((r) => r.name === "example/calc").length, 0);
});

test("parseGoTest collects build-output so a compile failure keeps its diagnostics", () => {
  // Go 1.27 reports compilation through build-output/build-fail, naming the
  // build target rather than the package.
  const rows = parseGoTest([
    { ImportPath: "example/calc [example/calc.test]", Action: "build-output", Output: "# example/calc\n" },
    { ImportPath: "example/calc [example/calc.test]", Action: "build-output", Output: "calc.go:3:2: undefined: missing\n" },
    { ImportPath: "example/calc [example/calc.test]", Action: "build-fail" },
    { Time: "2024-01-01T10:00:00Z", Action: "fail", Package: "example/calc", Elapsed: 0 },
  ].map((e) => JSON.stringify(e)).join("\n"));
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["example/calc", "fail"]]);
  assert.equal(rows[0].message, "# example/calc\ncalc.go:3:2: undefined: missing");
});

test("parseGoTest rejects a stream caught mid-write rather than losing the failure", () => {
  // The passing event is complete and the failing one is not; returning just the
  // pass would replace the last finished run with a green one.
  assert.throws(() => parseGoTest(`{"Action":"pass","Package":"p","Test":"TestA","Elapsed":0.1}\n{"Action":"fail","Package":"p","Test":"TestB","Elap`));
});

test("parseGoTest rejects a stream that ends with a test still running", () => {
  // Syntactically complete, but TestB never reported an outcome: returning only
  // TestA would show a green run whose result is not known yet.
  assert.throws(() => parseGoTest([
    { Action: "run", Package: "p", Test: "TestA" },
    { Action: "pass", Package: "p", Test: "TestA", Elapsed: 0.01 },
    { Action: "run", Package: "p", Test: "TestB" },
  ].map((e) => JSON.stringify(e)).join("\n")));
});

test("parseGoTest rejects a stream cut between two tests", () => {
  // TestA is complete, so only the package's missing terminal event shows that
  // the run had not finished.
  assert.throws(() => parseGoTest([
    { Action: "run", Package: "p", Test: "TestA" },
    { Action: "pass", Package: "p", Test: "TestA", Elapsed: 0.01 },
  ].map((e) => JSON.stringify(e)).join("\n")));
});

test("parseDart pairs testStart/testDone, drops hidden entries and keeps errors", () => {
  const rows = parseDart(DART);
  assert.deepEqual(rows.map((r) => r.name), ["calc adds", "calc subtracts", "calc divides"]);
  assert.deepEqual(statuses(rows), ["pass", "fail", "skip"]);
  assert.equal(rows[0].durationMs, 42);
  assert.equal(rows[0].file, "test/calc_test.dart");
  assert.equal(rows[1].message, "Expected: 1\ncalc_test.dart 7:5");
});

test("parseDart returns nothing for a run that finished with no test", () => {
  assert.deepEqual(parseDart(`{"protocolVersion":"0.1.1","type":"start","time":0}\n{"type":"done","success":true,"time":1}`), []);
});

test("parseDart rejects a run that never reported its done event", () => {
  // Every test it mentions finished, and it is still a snapshot taken before
  // the run ended.
  assert.throws(() => parseDart([
    { type: "suite", suite: { id: 0, path: "test/calc_test.dart" } },
    { type: "testStart", test: { id: 1, name: "adds", suiteID: 0 }, time: 1 },
    { type: "testDone", testID: 1, result: "success", hidden: false, time: 5 },
  ].map((e) => JSON.stringify(e)).join("\n")));
});

// --- Rust libtest / nextest ------------------------------------------------

const RUST = [
  { type: "suite", event: "started", test_count: 3 },
  { type: "test", event: "started", name: "calc::adds" },
  { type: "test", name: "calc::adds", event: "ok", exec_time: 0.042 },
  { type: "test", name: "calc::subtracts", event: "failed", stdout: "assertion failed: 1 == 2\n" },
  { type: "test", name: "calc::divides", event: "ignored" },
  { type: "suite", event: "failed", passed: 1, failed: 1, ignored: 1 },
].map((e) => JSON.stringify(e)).join("\n");

test("parseRustJson reads test events and splits the module path", () => {
  const rows = parseRustJson(RUST);
  assert.deepEqual(rows.map((r) => r.name), ["calc::adds", "calc::subtracts", "calc::divides"]);
  assert.deepEqual(statuses(rows), ["pass", "fail", "skip"]);
  assert.equal(rows[0].durationMs, 42);
  assert.equal(rows[0].className, "calc");
  assert.equal(rows[0].method, "adds");
  assert.equal(rows[1].message, "assertion failed: 1 == 2\n");
});

test("parseDart fails a test whose error arrives after it was reported done", () => {
  // The protocol allows an asynchronous error with no second testDone behind
  // it, so the run's own failure would otherwise be reported as green.
  const rows = parseDart([
    { type: "suite", suite: { id: 0, path: "test/calc_test.dart" } },
    { type: "testStart", test: { id: 1, name: "adds", suiteID: 0 }, time: 1 },
    { type: "testDone", testID: 1, result: "success", hidden: false, time: 5 },
    { type: "error", testID: 1, error: "Bad state: stream closed", stackTrace: "calc_test.dart 9:3", time: 6 },
    { type: "done", success: false, time: 7 },
  ].map((e) => JSON.stringify(e)).join("\n"));
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["adds", "fail"]]);
  assert.equal(rows[0].message, "Bad state: stream closed\ncalc_test.dart 9:3");
});

test("parseDart reports a failed run that no test admits to", () => {
  const rows = parseDart([
    { type: "testStart", test: { id: 1, name: "adds", suiteID: 0 }, time: 1 },
    { type: "testDone", testID: 1, result: "success", hidden: false, time: 5 },
    { type: "done", success: false, time: 6 },
  ].map((e) => JSON.stringify(e)).join("\n"));
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["adds", "pass"], ["dart test run failed", "fail"]]);
});

test("parseDart rejects a stream that ends with a test still running", () => {
  assert.throws(() => parseDart([
    { type: "suite", suite: { id: 0, path: "test/calc_test.dart" } },
    { type: "testStart", test: { id: 1, name: "adds", suiteID: 0 }, time: 1 },
    { type: "testDone", testID: 1, result: "success", hidden: false, time: 5 },
    { type: "testStart", test: { id: 2, name: "subtracts", suiteID: 0 }, time: 6 },
  ].map((e) => JSON.stringify(e)).join("\n")));
});

test("parseRustJson rejects a stream that ends with a test still running", () => {
  assert.throws(() => parseRustJson([
    { type: "suite", event: "started", test_count: 2 },
    { type: "test", event: "started", name: "calc::adds" },
    { type: "test", name: "calc::adds", event: "ok" },
    { type: "test", event: "started", name: "calc::subtracts" },
  ].map((e) => JSON.stringify(e)).join("\n")));
});

test("parseRustJson returns nothing for a suite that ran no test", () => {
  assert.deepEqual(parseRustJson(`{"type":"suite","event":"started","test_count":0}\n{"type":"suite","event":"ok","passed":0}`), []);
});

test("parseRustJson rejects a suite that never closed or fell short of its count", () => {
  const finished = `{"type":"test","name":"calc::adds","event":"ok"}`;
  // Started, one test reported, no terminal suite event.
  assert.throws(() => parseRustJson(`{"type":"suite","event":"started","test_count":2}\n${finished}`));
  // Closed, but a test it promised never arrived.
  assert.throws(() => parseRustJson(`{"type":"suite","event":"started","test_count":2}\n${finished}\n{"type":"suite","event":"ok","passed":1}`));
});
