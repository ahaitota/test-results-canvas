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

test("parseNUnit rejects a case missing its name or a known result, and lets a failure speak", () => {
  const wrap = (cases: string) => `<test-run id="1"><test-suite name="s">${cases}</test-suite></test-run>`;
  // The nameless failure would otherwise vanish, leaving one passing test.
  assert.throws(() => parseNUnit(wrap(`<test-case name="ok" result="Passed" /><test-case result="Failed"><failure><message>boom</message></failure></test-case>`)));
  assert.throws(() => parseNUnit(wrap(`<test-case name="a" result="Exploded" />`)));
  // A case carrying a failure failed, whatever its result attribute claims.
  const rows = parseNUnit(wrap(`<test-case name="a" result="Passed"><failure><message>boom</message></failure></test-case>`));
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["a", "fail"]]);
});

test("parseNUnit counts a warning as a test that ran, keeping what it warned about", () => {
  // A warning is not a failure and not a test nobody ran; calling it skipped
  // takes it out of the pass rate it belongs in.
  const rows = parseNUnit(`<test-run id="1" result="Warning">
  <test-suite type="TestFixture" name="CalcTests" result="Warning">
    <test-case name="Adds" result="Warning" duration="0.01">
      <assertions><assertion result="Warning"><message><![CDATA[rounding drifted]]></message></assertion></assertions>
    </test-case>
  </test-suite>
</test-run>`);
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["Adds", "pass"]]);
  assert.equal(rows[0].message, "rounding drifted");
});

test("parseNUnit reconciles the counters the run declares", () => {
  // Counted from the <test-case> elements, which is what NUnit counts -- the
  // suite-level rows this parser adds are failures NUnit counts nowhere.
  const run = (counts: string, cases: string) => `<test-run ${counts}><test-suite type="TestFixture" name="F">${cases}</test-suite></test-run>`;
  const passing = `<test-case name="a" result="Passed" />`;
  assert.throws(() => parseNUnit(run(`passed="1" failed="1"`, passing)));
  assert.equal(parseNUnit(run(`passed="1" failed="0"`, passing)).length, 1);
  // A warning is its own counter, and is not a test that failed or was skipped.
  assert.equal(parseNUnit(run(`passed="1" warnings="1"`, `${passing}<test-case name="w" result="Warning" />`)).length, 2);
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

test("parseXunit rejects a record missing its name or outcome, and never calls a failure a skip", () => {
  const assembly = (tests: string) => `<assemblies><assembly name="a.dll"><collection name="c">${tests}</collection></assembly></assemblies>`;
  // No result attribute: defaulting turned this failure into a test nobody ran.
  assert.throws(() => parseXunit(assembly(`<test name="boom"><failure><message>bad</message></failure></test>`)));
  assert.throws(() => parseXunit(assembly(`<test type="Ns" method="boom" result="Fail" />`)));
  assert.throws(() => parseXunit(assembly(`<test name="boom" result="Exploded" />`)));
  // A record that carries a failure failed, whatever it says of itself.
  const rows = parseXunit(assembly(`<test name="boom" result="Skip"><failure><message>bad</message></failure></test>`));
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["boom", "fail"]]);
});

test("parseXunit rejects an assembly declaring errors it does not record", () => {
  // An assembly-level error is a failure no test carries, so one it counts but
  // does not write down is a failure that would simply vanish.
  assert.throws(() => parseXunit(`<assemblies><assembly name="a.dll" errors="1" passed="1" failed="0" skipped="0"><collection name="c"><test name="ok" result="Pass" /></collection></assembly></assemblies>`));
  assert.equal(parseXunit(`<assemblies><assembly name="a.dll" errors="0" passed="1" failed="0" skipped="0"><collection name="c"><test name="ok" result="Pass" /></collection></assembly></assemblies>`).length, 1);
});

test("parseXunit rejects an assembly whose own counters do not match its tests", () => {
  const assembly = (counts: string, tests: string) => `<assemblies><assembly name="a.dll" ${counts}><collection name="c">${tests}</collection></assembly></assemblies>`;
  const one = `<test name="adds" result="Pass" />`;
  assert.throws(() => parseXunit(assembly(`passed="1" failed="1" skipped="0"`, one)));
  // Counted correctly, including v3's `not-run` (and the older `notrun`).
  assert.equal(parseXunit(assembly(`passed="1" failed="0" skipped="0"`, one)).length, 1);
  assert.equal(parseXunit(assembly(`passed="1" failed="0" skipped="0" not-run="1"`, `${one}<test name="pending" result="NotRun" />`)).length, 2);
  assert.equal(parseXunit(assembly(`passed="1" failed="0" skipped="0" notrun="1"`, `${one}<test name="pending" result="NotRun" />`)).length, 2);
  // A report that does not count itself is left alone.
  assert.equal(parseXunit(assembly(`total="1"`, one)).length, 1);
  // The counters are checked one by one: a total that still adds up hides a
  // failure that has arrived as a pass.
  assert.throws(() => parseXunit(assembly(`total="2" passed="1" failed="1" skipped="0"`, `${one}<test name="subtracts" result="Pass" />`)));
  // A total on its own still says how many tests there should have been.
  assert.throws(() => parseXunit(assembly(`total="2"`, one)));
  // Counters come as a set, so a hole in one -- or a value that is not a
  // number -- is a report that cannot be checked against itself.
  assert.throws(() => parseXunit(assembly(`passed="1" skipped="0"`, one)));
  assert.throws(() => parseXunit(assembly(`passed="one" failed="0" skipped="0"`, one)));
});

test("parseXunit counts not-run tests apart from the tests that ran", () => {
  // The schema says `total` is how many RAN; a NotRun test is one the runner
  // was asked to leave alone, and has a counter of its own.
  const assembly = (counts: string, tests: string) => `<assemblies><assembly name="a.dll" ${counts}><collection name="c">${tests}</collection></assembly></assemblies>`;
  const both = `<test name="adds" result="Pass" /><test name="explicit" result="NotRun" />`;
  const rows = parseXunit(assembly(`total="1" passed="1" failed="0" skipped="0" not-run="1"`, both));
  assert.deepEqual(rows.map((r) => r.status), ["pass", "skip"]);
  // A not-run count of its own that disagrees is still a disagreement.
  assert.throws(() => parseXunit(assembly(`total="1" passed="1" failed="0" skipped="0" not-run="2"`, both)));
  // And `total` counts the run ones, so counting the not-run one in is wrong.
  assert.throws(() => parseXunit(assembly(`total="2" passed="1" failed="0" skipped="0" not-run="1"`, both)));
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

test("parseTestNG reconciles the counters against the tests, not the fixtures", () => {
  // TestNG counts its passed/failed/skipped TEST collections: configuration
  // methods are held apart and never counted, and a retried attempt is counted
  // as a retry rather than as a skip.
  const results = (counts: string, methods: string) => `<testng-results ${counts}><suite name="s"><test name="t"><class name="C">${methods}</class></test></suite></testng-results>`;
  const passing = `<test-method name="a" status="PASS" />`;
  assert.throws(() => parseTestNG(results(`passed="1" failed="1"`, passing)));
  assert.equal(parseTestNG(results(`passed="1" failed="0"`, passing)).length, 1);
  // A failed setup is shown as a row but is not one of the counted tests.
  assert.equal(parseTestNG(results(`passed="1" failed="0"`, `${passing}<test-method name="setUp" status="FAIL" is-config="true" />`)).length, 2);
  // A retried attempt is written as a skip but counted under `retried`.
  assert.equal(parseTestNG(results(`passed="1" skipped="0"`, `${passing}<test-method name="flaky" status="SKIP" retried="true" />`)).length, 2);
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

test("parseTestNG rejects a method missing its name or a known status", () => {
  const wrap = (method: string) => `<testng-results><suite name="s"><test name="t"><class name="C">${method}</class></test></suite></testng-results>`;
  assert.throws(() => parseTestNG(wrap(`<test-method status="FAIL"><exception class="E"><message>boom</message></exception></test-method>`)));
  assert.throws(() => parseTestNG(wrap(`<test-method status="EXPLODED" name="a" />`)));
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
      <Test>./calc/divides</Test>
    </TestList>
    <Test Status="passed">
      <Name>adds</Name><Path>./calc</Path>
      <Results><NamedMeasurement type="numeric/double" name="Execution Time"><Value>0.042</Value></NamedMeasurement></Results>
    </Test>
    <Test Status="failed">
      <Name>subtracts</Name><Path>./calc</Path>
      <Results>
        <NamedMeasurement type="numeric/double" name="Execution Time"><Value>0.015</Value></NamedMeasurement>
        <NamedMeasurement type="text/string" name="Exit Code"><Value>SegFault</Value></NamedMeasurement>
        <NamedMeasurement type="text/string" name="Completion Status"><Value>SegFault</Value></NamedMeasurement>
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

test("parseCTest keeps the output when the reason is only that the test ended", () => {
  // A test that runs to the end and returns non-zero completes, so its
  // "Completion Status" says nothing the status column doesn't already.
  const xml = `<Site><Testing><Test Status="failed"><Name>a</Name><Results><NamedMeasurement name="Completion Status"><Value>Completed</Value></NamedMeasurement><Measurement><Value>assertion failed</Value></Measurement></Results></Test></Testing></Site>`;
  assert.equal(parseCTest(xml)[0].message, "assertion failed");
});

test("parseCTest rejects a result missing its name or a known status", () => {
  // Dropping either would take a failure off the run and leave a shorter,
  // greener report behind.
  assert.throws(() => parseCTest(`<Site><Testing><Test Status="failed"><Results><Measurement><Value>boom</Value></Measurement></Results></Test></Testing></Site>`));
  assert.throws(() => parseCTest(`<Site><Testing><Test Status="exploded"><Name>a</Name></Test></Testing></Site>`));
  // The outcomes CTest does write are all read.
  const rows = parseCTest(`<Site><Testing><Test Status="notrun"><Name>a</Name></Test><Test Status="disabled"><Name>b</Name></Test></Testing></Site>`);
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["a", "skip"], ["b", "skip"]]);
});

test("parseCTest rejects a report holding fewer results than its TestList", () => {
  // CTest writes the list and the results from one and the same set of tests,
  // so a short one means the file was cut off partway through them.
  const report = (results: string) => `<Site><Testing><TestList><Test>./a</Test><Test>./b</Test></TestList>${results}</Testing></Site>`;
  assert.throws(() => parseCTest(report(`<Test Status="passed"><Name>a</Name></Test>`)));
  assert.equal(parseCTest(report(`<Test Status="passed"><Name>a</Name></Test><Test Status="failed"><Name>b</Name></Test>`)).length, 2);
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

test("parseTap rejects a stream cut inside a diagnostic block", () => {
  assert.throws(() => parseTap("TAP version 13\n1..1\nok 1 - green\n  ---\n  message: still being written\n"));
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

test("parseTap numbers an unnumbered point the way TAP says it is numbered", () => {
  // The implicit point takes number 2, so the explicit "2" behind it repeats a
  // point and nothing ever reports number 3.
  const rows = parseTap("TAP version 13\n1..3\nok 1 - first\nok - implicit second\nok 2 - duplicate second\n");
  assert.equal(rows[rows.length - 1].name, "TAP stream not valid");
  // Numbered implicitly all the way through, the same stream is complete.
  assert.deepEqual(parseTap("TAP version 13\n1..3\nok - a\nok - b\nok - c\n").map((r) => r.name), ["a", "b", "c"]);
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
    summary: { tests: 3, passed: 1, failed: 1, skipped: 1, pending: 0, other: 0 },
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
  assert.throws(() => parseCtrf(`{"reportFormat":"CTRF","results":{"tool":{"name":"jest"},"summary":{"tests":2,"passed":1,"failed":1,"skipped":0,"pending":0,"other":0},"tests":[{"name":"adds","status":"passed"}]}}`));
});

test("parseCtrf rejects a report with no results.tests array", () => {
  // reportFormat already claimed the file as CTRF, so these are malformed
  // reports, not runs in which nothing happened.
  assert.throws(() => parseCtrf(`{"reportFormat":"CTRF"}`));
  assert.throws(() => parseCtrf(`{"reportFormat":"CTRF","results":{}}`));
  assert.throws(() => parseCtrf(`{"reportFormat":"CTRF","results":{"tests":{}}}`));
  assert.throws(() => parseCtrf(`{"reportFormat":"CTRF","results":[]}`));
});

test("parseCtrf rejects a summary that disagrees with the tests it holds", () => {
  const counts = (over: Record<string, number>) => JSON.stringify({ tests: 1, passed: 0, failed: 0, skipped: 0, pending: 0, other: 0, ...over });
  const report = (summary: string, tests: string) => `{"reportFormat":"CTRF","results":{"tool":{"name":"jest"},"summary":${summary},"tests":[${tests}]}}`;
  // A summary claiming a failure none of its tests admit to is the same
  // disagreement as a missing row, pointing the other way.
  assert.throws(() => parseCtrf(report(counts({ passed: 1, failed: 1 }), `{"name":"a","status":"passed"}`)));
  assert.equal(parseCtrf(report(counts({ failed: 1 }), `{"name":"a","status":"failed"}`)).length, 1);
  // A counter the schema requires, missing or not a number, leaves the tests
  // with nothing to be checked against.
  assert.throws(() => parseCtrf(report(`{"tests":1,"passed":1}`, `{"name":"a","status":"passed"}`)));
  assert.throws(() => parseCtrf(report(counts({ passed: 1 }).replace(`"passed":1`, `"passed":"1"`), `{"name":"a","status":"passed"}`)));
});

test("parseCtrf reads a suite path as well as a suite name", () => {
  const rows = parseCtrf(`{"reportFormat":"CTRF","results":{"tool":{"name":"jest"},"summary":{"tests":1,"passed":1,"failed":0,"skipped":0,"pending":0,"other":0},"tests":[{"name":"a","status":"passed","suite":["root","calc"]}]}}`);
  assert.equal(rows[0].suite, "root > calc");
});

test("parseCtrf returns nothing for a report with no tests", () => {
  assert.deepEqual(parseCtrf(`{"reportFormat":"CTRF","results":{"summary":{"tests":0,"passed":0,"failed":0,"skipped":0,"pending":0,"other":0},"tests":[]}}`), []);
});

test("parseCtrf rejects a report with no summary to check itself against", () => {
  // The schema requires one, and without it nothing in the file says whether
  // the tests it lists are all the tests there were.
  assert.throws(() => parseCtrf(`{"reportFormat":"CTRF","results":{"tests":[{"name":"a","status":"passed"}]}}`));
});

test("parseCtrf reconciles every counter its summary declares", () => {
  // A total that still adds up hides a failure replaced by a pass.
  const report = (summary: string) => `{"reportFormat":"CTRF","results":{"summary":${summary},"tests":[{"name":"a","status":"passed"}]}}`;
  assert.throws(() => parseCtrf(report(`{"tests":1,"passed":0,"failed":0,"skipped":1,"pending":0,"other":0}`)));
  assert.throws(() => parseCtrf(report(`{"tests":1,"passed":0,"failed":0,"skipped":0,"pending":1,"other":0}`)));
  assert.equal(parseCtrf(report(`{"tests":1,"passed":1,"failed":0,"skipped":0,"pending":0,"other":0}`)).length, 1);
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
  // One object per file, which is how Allure writes them.
  const rows = [
    { uuid: "b", name: "broke", status: "broken" },
    { uuid: "c", name: "unclear", status: "unknown" },
    { uuid: "d", name: "ok", status: "passed" },
  ].flatMap((r) => parseAllure(JSON.stringify(r)));
  assert.deepEqual(statuses(rows), ["fail", "skip", "pass"]);
});

test("parseAllure rejects a file that is not one result or container", () => {
  // An empty array contributes no rows and no complaint, so an Allure folder
  // holding one would look like a run those tests were never part of.
  assert.throws(() => parseAllure(`[]`));
  assert.throws(() => parseAllure(`[{"uuid":"a","name":"x","status":"passed"}]`));
  // A container whose fixtures are not a list would lose the failure inside it.
  assert.throws(() => parseAllure(`{"uuid":"c","children":["a"],"afters":{"name":"cleanup","status":"broken"}}`));
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

test("parseAllure reports a fixture that failed in a container", () => {
  // Allure records setup and teardown only here, so a teardown that blew up is
  // a failure of the run that no test result mentions.
  const rows = parseAllure(JSON.stringify({
    uuid: "c1",
    name: "DatabaseFixture",
    children: ["r1"],
    befores: [{ name: "connect", status: "passed", start: 1, stop: 2 }],
    afters: [{
      name: "disconnect",
      status: "broken",
      statusDetails: { message: "the connection was already closed", trace: "at Db.Dispose()" },
      start: 10,
      stop: 25,
    }],
  }));
  // The successful setup is not a test and would only inflate the run.
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["disconnect", "fail"]]);
  assert.equal(rows[0].message, "the connection was already closed\nat Db.Dispose()");
  assert.equal(rows[0].suite, "DatabaseFixture");
  assert.equal(rows[0].durationMs, 15);
});

test("parseAllure rejects a fixture it cannot read, which would be a lost failure", () => {
  // The broken teardown with no name is exactly the failure that would
  // otherwise leave the folder looking green.
  assert.throws(() => parseAllure(JSON.stringify({
    uuid: "c", children: ["r"], afters: [{ status: "broken", statusDetails: { message: "cleanup failed" } }],
  })));
  assert.throws(() => parseAllure(JSON.stringify({ uuid: "c", children: [], befores: [{ name: "setup", status: "exploded" }] })));
});

test("parseAllure still rejects a result that only looks like a container", () => {
  // No befores/afters/children, so this is a result missing its status -- not a
  // container, and not something to pass over in silence.
  assert.throws(() => parseAllure(`{"uuid":"b","name":"adds"}`));
});

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

test("parseGoTest rejects a second run appended to a finished one", () => {
  // A package reports its own outcome last, so anything after that belongs to
  // another run -- and which rows belong to which is then anyone's guess.
  assert.throws(() => parseGoTest([
    { Action: "run", Package: "p", Test: "TestA" },
    { Action: "pass", Package: "p", Test: "TestA", Elapsed: 0.01 },
    { Action: "pass", Package: "p", Elapsed: 0.1 },
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
  assert.equal(rows[1].message, "assertion failed: 1 == 2");
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

test("parseDart rejects a run that did not report whether it succeeded", () => {
  // `success` is the verdict; null means the run was interrupted, which is not
  // a run to present as finished.
  assert.throws(() => parseDart([
    { type: "testStart", test: { id: 1, name: "a" }, time: 0 },
    { type: "testDone", testID: 1, result: "success", hidden: false, time: 1 },
    { type: "done", time: 2 },
  ].map((e) => JSON.stringify(e)).join("\n")));
});

test("parseDart rejects a testStart it cannot read", () => {
  assert.throws(() => parseDart(`{"type":"testStart","test":{"id":1},"time":0}\n{"type":"done","success":true,"time":1}`));
});

test("parseDart rejects a stream that ends with a test still running", () => {
  assert.throws(() => parseDart([
    { type: "suite", suite: { id: 0, path: "test/calc_test.dart" } },
    { type: "testStart", test: { id: 1, name: "adds", suiteID: 0 }, time: 1 },
    { type: "testDone", testID: 1, result: "success", hidden: false, time: 5 },
    { type: "testStart", test: { id: 2, name: "subtracts", suiteID: 0 }, time: 6 },
  ].map((e) => JSON.stringify(e)).join("\n")));
});

test("parseDart rejects a second run appended to a finished one", () => {
  // `done` ends a run, so events behind it belong to another -- and the first
  // run's own done would vouch for tests that were never part of it.
  assert.throws(() => parseDart([
    { type: "suite", suite: { id: 0, path: "test/calc_test.dart" } },
    { type: "testStart", test: { id: 1, name: "adds", suiteID: 0 }, time: 1 },
    { type: "testDone", testID: 1, result: "success", hidden: false, time: 2 },
    { type: "done", success: true, time: 3 },
    { type: "testStart", test: { id: 2, name: "subtracts", suiteID: 0 }, time: 4 },
    { type: "testDone", testID: 2, result: "success", hidden: false, time: 5 },
  ].map((e) => JSON.stringify(e)).join("\n")));
});

test("parseDart rejects a run missing one of the suites it announced", () => {
  const events = (count: number) => [
    { type: "allSuites", count },
    { type: "suite", suite: { id: 0, path: "test/calc_test.dart" } },
    { type: "testStart", test: { id: 1, name: "adds", suiteID: 0 }, time: 1 },
    { type: "testDone", testID: 1, result: "success", hidden: false, time: 2 },
    { type: "done", success: true, time: 3 },
  ].map((e) => JSON.stringify(e)).join("\n");
  // A suite that never reported is every test in it missing from the run.
  assert.throws(() => parseDart(events(2)));
  assert.equal(parseDart(events(1)).length, 1);
});

test("parseDart rejects an allSuites count it cannot read", () => {
  // Without a usable count there is nothing to notice a missing suite with.
  const withCount = (count: string) => [
    `{"type":"allSuites","count":${count}}`,
    `{"type":"suite","suite":{"id":0,"path":"a_test.dart"}}`,
    `{"type":"testStart","test":{"id":1,"name":"a","suiteID":0}}`,
    `{"type":"testDone","testID":1,"result":"success","hidden":false}`,
    `{"type":"done","success":true}`,
  ].join("\n");
  assert.throws(() => parseDart(withCount(`"1"`)));
  assert.throws(() => parseDart(withCount(`null`)));
  assert.equal(parseDart(withCount(`1`)).length, 1);
});

test("parseRustJson leaves a timed-out test running rather than failing it twice", () => {
  // libtest reports a timeout to say a test is taking a while; its outcome
  // still follows. Counting it invented a row and broke the suite's own count.
  const rows = parseRustJson([
    { type: "suite", event: "started", test_count: 1 },
    { type: "test", event: "started", name: "calc::slow" },
    { type: "test", event: "timeout", name: "calc::slow" },
    { type: "test", event: "ok", name: "calc::slow", exec_time: 61 },
    { type: "suite", event: "ok", passed: 1, failed: 0, ignored: 0 },
  ].map((e) => JSON.stringify(e)).join("\n"));
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["calc::slow", "pass"]]);
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
  assert.deepEqual(parseRustJson(`{"type":"suite","event":"started","test_count":0}\n{"type":"suite","event":"ok","passed":0,"failed":0,"ignored":0}`), []);
});

test("parseRustJson reports a suite that failed with no failing test", () => {
  // libtest says the suite failed; something outside the tests did. A green run
  // would be the wrong thing to show, and the tally may not be there to catch it.
  const rows = parseRustJson(`{"type":"suite","event":"started","test_count":1}\n{"type":"test","event":"ok","name":"only_pass"}\n{"type":"suite","event":"failed"}`);
  assert.deepEqual(rows.map((r) => r.status), ["pass", "fail"]);
});

test("parseRustJson rejects test events with no suite, and a half-written tally", () => {
  // libtest always opens with a suite, so events without one are a capture that
  // began after the run did.
  assert.throws(() => parseRustJson(`{"type":"test","event":"ok","name":"only_pass"}`));
  // The counters are written together; a set with a hole in it is malformed.
  assert.throws(() => parseRustJson(`{"type":"suite","event":"started","test_count":1}\n{"type":"test","event":"ok","name":"a"}\n{"type":"suite","event":"ok","passed":1,"ignored":0}`));
});

test("parseRustJson reconciles the tally the suite closes with", () => {
  // The count still adds up, so only the per-outcome tally notices that the
  // failure libtest recorded has arrived as a pass.
  const one = (event: string) => `{"type":"suite","event":"started","test_count":1}\n{"type":"test","name":"calc::adds","event":"${event}"}\n{"type":"suite","event":"failed","passed":0,"failed":1,"ignored":0}`;
  assert.throws(() => parseRustJson(one("ok")));
  assert.equal(parseRustJson(one("failed")).length, 1);
  // A verdict libtest does not write is not a verdict at all.
  assert.throws(() => parseRustJson(`{"type":"suite","event":"started","test_count":0}\n{"type":"suite","event":"interrupted"}`));
  // Older writers close without a tally, which is not a disagreement.
  assert.equal(parseRustJson(`{"type":"suite","event":"started","test_count":1}\n{"type":"test","name":"a","event":"ok"}\n{"type":"suite","event":"ok"}`).length, 1);
});

test("parseRustJson rejects a suite that never closed or fell short of its count", () => {
  const finished = `{"type":"test","name":"calc::adds","event":"ok"}`;
  // Started, one test reported, no terminal suite event.
  assert.throws(() => parseRustJson(`{"type":"suite","event":"started","test_count":2}\n${finished}`));
  // Closed, but a test it promised never arrived.
  assert.throws(() => parseRustJson(`{"type":"suite","event":"started","test_count":2}\n${finished}\n{"type":"suite","event":"ok","passed":1}`));
});
