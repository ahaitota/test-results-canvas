// Format detection and the file-level entry points of the parser registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectParser, looksLikeResults, parseResults, parseResultsAt, canonicalResultPaths, expandsDirectory, RESULT_EXTS } from "../src/parsers/registry.js";

const id = (text: string) => detectParser(text)?.id;

const SAMPLES: [string, string][] = [
  ["trx", `<?xml version="1.0"?><TestRun id="x"><Results /></TestRun>`],
  ["junit", `<testsuites><testsuite name="s"><testcase name="a" /></testsuite></testsuites>`],
  ["nunit", `<test-run id="2"><test-suite name="s"><test-case name="a" result="Passed" /></test-suite></test-run>`],
  ["xunit", `<assemblies><assembly name="a.dll"><collection name="c"><test name="a" result="Pass" /></collection></assembly></assemblies>`],
  ["testng", `<testng-results total="1"><suite name="s" /></testng-results>`],
  ["ctest", `<Site Name="ci"><Testing><Test Status="passed"><Name>a</Name></Test></Testing></Site>`],
  ["ctrf", `{"reportFormat":"CTRF","results":{"tests":[{"name":"a","status":"passed"}]}}`],
  ["allure", `{"uuid":"1","name":"a","status":"passed"}`],
  ["gotest", `{"Action":"run","Package":"p","Test":"T"}`],
  ["dart", `{"protocolVersion":"0.1.1","type":"start","time":0}`],
  ["rust", `{"type":"suite","event":"started","test_count":1}`],
  ["tap", `TAP version 13\n1..1\nok 1 - a\n`],
];

test("detectParser routes each format to its own parser", () => {
  for (const [expected, text] of SAMPLES) assert.equal(id(text), expected, expected);
});

test("looksLikeResults rejects files that are not reports", () => {
  const notReports = [
    `{"name":"pkg","version":"1.0.0","scripts":{"test":"node --test"}}`,
    `{"compilerOptions":{"strict":true}}`,
    "<html><body>ok</body></html>",
    "TF: src/calc.ts\nDA:1,1\nend_of_record\n",
    "",
  ];
  for (const text of notReports) assert.equal(looksLikeResults(text), false, text.slice(0, 20));
});

test("looksLikeResults rejects the coverage reports that share a folder with a run", () => {
  // Cobertura/JaCoCo/LCOV live beside the results and are also .xml/.info, so a
  // results scan must never claim one of them.
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "e2e", "fixtures", "coverage");
  const names = readdirSync(dir);
  assert.ok(names.length > 0);
  for (const name of names) assert.equal(looksLikeResults(readFileSync(join(dir, name), "utf8")), false, name);
});

test("looksLikeResults rejects reports from runners this canvas does not parse", () => {
  // Each of these carries the generic keys a loose predicate would match, and
  // sits in the same folder as the run's real report -- so claiming one would
  // let it win the "newest report" race and blank the panel.
  const lookalikes = [
    // jest --json / vitest --reporter=json: fullName + status, no uuid.
    `{"numFailedTests":1,"testResults":[{"assertionResults":[{"fullName":"calc adds","status":"passed"}]}]}`,
    // playwright --reporter=json: specs nest "tests" that nest "results".
    `{"config":{},"suites":[{"specs":[{"title":"adds","tests":[{"results":[{"status":"passed"}]}]}]}]}`,
    // A Windows side-by-side manifest saved as .xml.
    `<?xml version="1.0"?><assembly manifestVersion="1.0"><assemblyIdentity name="app" /></assembly>`,
  ];
  for (const text of lookalikes) assert.equal(looksLikeResults(text), false, text.slice(0, 30));
});

test("parseResultsAt skips an Allure sibling caught mid-write instead of dropping the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "allure-partial-"));
  const one = join(dir, "aaa-result.json");
  writeFileSync(one, `{"uuid":"aaa","name":"adds","status":"passed"}`, "utf8");
  writeFileSync(join(dir, "bbb-result.json"), `{"uuid":"bbb","name":"subt`, "utf8");
  assert.deepEqual(parseResultsAt(one)?.map((r) => r.name), ["adds"]);
});

test("detection reads the root element, so report content cannot pick the parser", () => {
  // A failure message that quotes markup is still just text. Searching raw bytes
  // for "<testsuite>" would hand this NUnit report to the JUnit parser, which
  // finds nothing in it.
  const nunit = `<?xml version="1.0"?>
<test-run id="1">
  <test-suite type="TestFixture" name="Markup">
    <test-case name="Reports" result="Failed" duration="0.01">
      <failure><message><![CDATA[expected no <testsuite> element]]></message></failure>
    </test-case>
  </test-suite>
</test-run>`;
  assert.equal(id(nunit), "nunit");
  assert.deepEqual(parseResults(nunit)?.map((r) => [r.name, r.status]), [["Reports", "fail"]]);
  // Same for a TRX whose captured output mentions a JUnit document.
  assert.equal(id(`<TestRun id="1"><Output>wrote <testsuites></Output></TestRun>`), "trx");
});

test("CTest is not confused with the other documents rooted at <Site>", () => {
  assert.equal(id(`<Site Name="ci"><Build><Log>ok</Log></Build></Site>`), undefined);
});

test("expandsDirectory marks the sources a sibling change belongs to", () => {
  // The watcher uses this to know that a brand-new Allure result changed the
  // source named after a different file in that folder.
  const dir = mkdtempSync(join(tmpdir(), "expands-"));
  const allure = join(dir, "aaa-result.json");
  const junit = join(dir, "run.xml");
  writeFileSync(allure, `{"uuid":"aaa","name":"adds","status":"passed"}`, "utf8");
  writeFileSync(junit, `<testsuites><testsuite name="s"><testcase name="c" /></testsuite></testsuites>`, "utf8");
  assert.equal(expandsDirectory(allure), true);
  assert.equal(expandsDirectory(junit), false);
  assert.equal(expandsDirectory(join(dir, "gone.xml")), false);
});

test("parseResults rejects XML that is not well formed", () => {
  // An unquoted attribute value: attr() can only skip what it cannot read, so
  // this used to parse to a run whose tests had lost their names.
  assert.equal(parseResults(`<testsuites><testsuite name="s"><testcase name=x /></testsuite></testsuites>`), null);
  // Two document elements is two documents, or one appended to.
  assert.equal(parseResults(`<testsuite name="a"><testcase name="x" /></testsuite><testsuite name="b"><testcase name="y" /></testsuite>`), null);
  // An end tag carrying attributes, and a value that never closes.
  assert.equal(parseResults(`<testsuites><testsuite name="s"></testsuite name="s"></testsuites>`), null);
  assert.equal(parseResults(`<testsuites><testsuite name="s><testcase name="x" /></testsuite></testsuites>`), null);
  // A repeated attribute: attr() returns the first, so the row would silently
  // take one of two conflicting names.
  assert.equal(parseResults(`<testsuites><testsuite name="a" name="b"><testcase name="x" /></testsuite></testsuites>`), null);
  // "</a/>" is not an end tag.
  assert.equal(parseResults(`<testsuites><testsuite name="s"><testcase name="x"></testcase/></testsuite></testsuites>`), null);
  // Only whitespace, comments, PIs and a doctype may sit outside the root.
  assert.equal(parseResults(`garbage<testsuites><testcase name="x" /></testsuites>`), null);
  assert.equal(parseResults(`<testsuites><testcase name="x" /></testsuites>tail`), null);
  // The declaration, a doctype and comments around the root are still fine.
  const framed = `<?xml version="1.0"?>\n<!-- run -->\n<testsuites><testsuite name="s"><testcase name="x" /></testsuite></testsuites>\n<!-- end -->\n`;
  assert.equal(parseResults(framed)?.length, 1);
});

test("parseResults rejects XML that was caught half-written", () => {
  // Truncated mid-document: parseXml is deliberately lenient, so without a
  // structural check these would replace a finished run with a shorter one.
  assert.equal(parseResults(`<test-run><test-suite name="s">`), null);
  assert.equal(parseResults(`<test-run><test-suite name="s"><test-case name="a" result="Passed" />`), null);
  assert.equal(parseResults(`<testsuites><testsuite name="s"><testcase name="a" /><!-- cut`), null);
  // The complete document is still accepted.
  assert.deepEqual(parseResults(`<test-run><test-suite name="s"><test-case name="a" result="Passed" /></test-suite></test-run>`)?.length, 1);
});

test("looksLikeResults rejects an Allure container, which carries no status of its own", () => {
  // Containers sit in the results folder and are newer than the results they
  // group, so claiming one would blank the run.
  assert.equal(looksLikeResults(`{"uuid":"c","children":["r"],"name":"suite","befores":[{"name":"setup","status":"passed"}]}`), false);
  assert.equal(looksLikeResults(`{"uuid":"r","name":"adds","status":"passed"}`), true);
});

test("canonicalResultPaths collapses an Allure folder to a single run", () => {
  const dir = mkdtempSync(join(tmpdir(), "allure-canon-"));
  const one = join(dir, "aaa-result.json");
  const two = join(dir, "bbb-result.json");
  writeFileSync(one, `{"uuid":"aaa","name":"adds","status":"passed"}`, "utf8");
  writeFileSync(two, `{"uuid":"bbb","name":"subtracts","status":"failed"}`, "utf8");
  const junit = join(dir, "junit.xml");
  writeFileSync(junit, `<testsuites><testsuite name="s"><testcase name="c" /></testsuite></testsuites>`, "utf8");

  // Both result files expand to the same set, so keeping both would merge every
  // row twice and parse the folder once per member.
  assert.deepEqual(canonicalResultPaths([one, two, junit]), [one, junit]);
  assert.deepEqual(parseResultsAt(one)?.length, 2);
});

test("parseResults rejects a file whose declared format is malformed", () => {
  // Detected as CTRF by its head, but the document is truncated: a broken report
  // must not surface as a run in which nothing failed.
  assert.equal(parseResults(`{"reportFormat":"CTRF","results":{"tests":[{"name":"a",`), null);
  assert.equal(parseResults("random log line\n"), null);
});

test("parseResults still returns rows for a report that ran no tests", () => {
  assert.deepEqual(parseResults(`{"reportFormat":"CTRF","results":{"tests":[]}}`), []);
});

test("RESULT_EXTS covers every discovered extension without dropping the originals", () => {
  assert.deepEqual([...RESULT_EXTS].sort(), [".jsonl", ".json", ".ndjson", ".tap", ".trx", ".xml"].sort());
});

test("parseResultsAt reads a file from disk and returns null for a missing one", () => {
  const dir = mkdtempSync(join(tmpdir(), "results-"));
  const abs = join(dir, "run.tap");
  writeFileSync(abs, "TAP version 13\n1..2\nok 1 - a\nnot ok 2 - b\n", "utf8");
  assert.deepEqual(parseResultsAt(abs)?.map((r) => r.status), ["pass", "fail"]);
  assert.equal(parseResultsAt(join(dir, "nope.tap")), null);
});

test("parseResultsAt merges a whole Allure results directory, in name order", () => {
  const dir = mkdtempSync(join(tmpdir(), "allure-"));
  const one = join(dir, "aaa-result.json");
  writeFileSync(one, `{"uuid":"aaa","name":"adds","status":"passed"}`, "utf8");
  writeFileSync(join(dir, "bbb-result.json"), `{"uuid":"bbb","name":"subtracts","status":"failed"}`, "utf8");
  // Attachments and container files sit in the same folder and are not results.
  writeFileSync(join(dir, "ccc-container.json"), `{"uuid":"ccc","children":[]}`, "utf8");
  const rows = parseResultsAt(one);
  assert.deepEqual(rows?.map((r) => [r.name, r.status]), [["adds", "pass"], ["subtracts", "fail"]]);
});
