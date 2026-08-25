// Unit tests for the three coverage report parsers and the format sniffer.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCobertura } from "../src/coverage/formats/cobertura.js";
import { parseLcov } from "../src/coverage/formats/lcov.js";
import { parseJacoco } from "../src/coverage/formats/jacoco.js";
import { detectCoverageFormat, parseCoverage, looksLikeCoverage } from "../src/coverage/formats/detect.js";
import type { CoverageFile } from "../src/coverage/model/types.js";

const byPath = (files: CoverageFile[]) => Object.fromEntries(files.map((f) => [f.path, f]));

const COBERTURA = `<?xml version="1.0"?>
<coverage line-rate="0.6" version="1.9">
  <sources>
    <source>/repo/src</source>
  </sources>
  <packages>
    <package name="App">
      <classes>
        <class name="Calc" filename="app/calc.cs">
          <lines>
            <line number="3" hits="4" />
            <line number="4" hits="0" />
            <line number="7" hits="2" branch="true" condition-coverage="50% (1/2)" />
          </lines>
        </class>
        <class name="Util" filename="app/util.cs">
          <lines>
            <line number="1" hits="0" />
            <line number="2" hits="0" />
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

test("parseCobertura reads filenames, hits, sources and branch conditions", () => {
  const report = parseCobertura(COBERTURA);
  assert.ok(report);
  assert.equal(report.format, "cobertura");
  assert.deepEqual(report.sourceRoots, ["/repo/src"]);

  const files = byPath(report.files);
  const calc = files["app/calc.cs"];
  assert.deepEqual(calc.lines, { 3: 4, 4: 0, 7: 2 });
  assert.equal(calc.coveredLines, 2);
  assert.equal(calc.totalLines, 3);
  assert.deepEqual(calc.branches, { covered: 1, total: 2 });

  assert.equal(files["app/util.cs"].coveredLines, 0);
  assert.equal(report.totals.files, 2);
  assert.equal(report.totals.coveredLines, 2);
  assert.equal(report.totals.totalLines, 5);
  assert.equal(report.totals.percent, 40);
});

test("parseCobertura merges partial classes sharing one filename", () => {
  const split = `<coverage><packages><package><classes>
    <class filename="a.cs"><lines><line number="1" hits="1"/><line number="2" hits="0"/></lines></class>
    <class filename="a.cs"><lines><line number="2" hits="3"/><line number="9" hits="0"/></lines></class>
  </classes></package></packages></coverage>`;
  const report = parseCobertura(split);
  assert.ok(report);
  assert.equal(report.files.length, 1, "one entry per source file, not per class");
  // Line 2 was uncovered in one partial and covered in the other; summing hits
  // is what a coverage tool means by merging.
  assert.deepEqual(report.files[0].lines, { 1: 1, 2: 3, 9: 0 });
  assert.equal(report.files[0].coveredLines, 2);
});

const LCOV = `TN:
SF:/repo/src/app/calc.ts
DA:1,5
DA:2,0
BRDA:2,0,0,1
BRDA:2,0,1,-
LF:2
LH:1
end_of_record
SF:/repo/src/app/calc.ts
DA:2,3
end_of_record
SF:/repo/src/app/dead.ts
DA:10,0
end_of_record
`;

test("parseLcov reads records, branches and merges repeated files", () => {
  const report = parseLcov(LCOV);
  assert.ok(report);
  assert.equal(report.format, "lcov");
  const files = byPath(report.files);
  assert.equal(Object.keys(files).length, 2);
  // Two records for the same file: hits add, so a line uncovered in the first
  // pass and covered in the second ends up covered.
  assert.deepEqual(files["/repo/src/app/calc.ts"].lines, { 1: 5, 2: 3 });
  assert.deepEqual(files["/repo/src/app/calc.ts"].branches, { covered: 1, total: 2 });
  assert.equal(files["/repo/src/app/dead.ts"].coveredLines, 0);
});

test("parseLcov tolerates a final record with no end_of_record", () => {
  const report = parseLcov("SF:a.ts\nDA:1,1\nDA:2,0\n");
  assert.ok(report);
  assert.equal(report.files.length, 1);
  assert.equal(report.files[0].totalLines, 2);
});

test("parseLcov counts a branch once however many records report it", () => {
  // A runner writes one record per test file, so a branch in a file three tests
  // touch is reported three times. Adding each record's totals up turned an
  // if/else into "6 of 6 branches", which reads as thorough and is one branch.
  const record = "SF:src/calc.ts\nDA:1,1\nBRDA:1,0,0,1\nBRDA:1,0,1,-\nend_of_record\n";
  const report = parseLcov(record + record + record);
  assert.ok(report);
  assert.equal(report.files.length, 1);
  assert.deepEqual(report.files[0].branches, { covered: 1, total: 2 });
});

test("parseLcov merges the two separator spellings of one path", () => {
  // A Windows runner can write either slash, sometimes both in one report.
  // Merging on the raw spelling left one file as two entries: its lines were
  // counted twice in the totals, and patch matching saw two candidates for
  // every changed line and could only call them ambiguous.
  const report = parseLcov("SF:src\\calc.ts\nDA:1,1\nDA:2,0\nend_of_record\nSF:src/calc.ts\nDA:2,4\nend_of_record\n");
  assert.ok(report);
  assert.equal(report.files.length, 1);
  assert.equal(report.files[0].path, "src/calc.ts");
  assert.deepEqual(report.files[0].lines, { 1: 1, 2: 4 });
  assert.equal(report.totals.files, 1);
  assert.equal(report.totals.totalLines, 2, "totals follow the merged files, not the raw records");
  assert.equal(report.totals.coveredLines, 2);
});

test("parseCobertura decodes an escaped source root", () => {
  // Left encoded, a real directory is unopenable, so every file in the report
  // fails to resolve and the panel can show numbers but never source.
  const report = parseCobertura(`<coverage><sources><source>C:/R&amp;D/src</source></sources>`
    + `<packages><package><classes><class filename="a.cs"><lines><line number="1" hits="1"/></lines></class>`
    + `</classes></package></packages></coverage>`);
  assert.ok(report);
  assert.deepEqual(report.sourceRoots, ["C:/R&D/src"]);
});

const JACOCO = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">
<report name="demo">
  <package name="com/example/app">
    <sourcefile name="Calc.java">
      <line nr="5" mi="0" ci="3" mb="0" cb="2"/>
      <line nr="6" mi="4" ci="0" mb="2" cb="0"/>
    </sourcefile>
  </package>
  <package name="com/example/util">
    <sourcefile name="Helper.java">
      <line nr="2" mi="0" ci="1" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`;

test("parseJacoco builds package-qualified paths and maps mi/ci to hits", () => {
  const report = parseJacoco(JACOCO);
  assert.ok(report);
  assert.equal(report.format, "jacoco");
  const files = byPath(report.files);
  const calc = files["com/example/app/Calc.java"];
  assert.ok(calc, "the package name must prefix the source file name");
  // JaCoCo has no execution counts, so a covered line is recorded as 1 hit.
  assert.deepEqual(calc.lines, { 5: 1, 6: 0 });
  assert.deepEqual(calc.branches, { covered: 2, total: 4 });
  assert.equal(files["com/example/util/Helper.java"].coveredLines, 1);
  assert.equal(report.totals.totalLines, 3);
});

test("parseJacoco keeps two modules' identical packages apart", () => {
  // An aggregate report nests packages under <group> per module, and two
  // modules routinely hold the same package and file name. Without the group
  // in the path both entries carry the same path and get merged into one file
  // with summed hits, so a line covered in one module reads as covered in both.
  const aggregate = `<?xml version="1.0" encoding="UTF-8"?>
<report name="all">
  <group name="api">
    <package name="com/example"><sourcefile name="Util.java">
      <line nr="7" mi="0" ci="2"/>
    </sourcefile></package>
  </group>
  <group name="worker">
    <package name="com/example"><sourcefile name="Util.java">
      <line nr="7" mi="3" ci="0"/>
    </sourcefile></package>
  </group>
</report>`;
  const files = byPath(parseJacoco(aggregate).files);
  assert.deepEqual(Object.keys(files).sort(), ["api/com/example/Util.java", "worker/com/example/Util.java"]);
  assert.deepEqual(files["api/com/example/Util.java"].lines, { 7: 1 });
  assert.deepEqual(files["worker/com/example/Util.java"].lines, { 7: 0 }, "the covered module must not cover the other");
});

test("detectCoverageFormat picks the dialect from content, not the filename", () => {
  assert.equal(detectCoverageFormat(COBERTURA), "cobertura");
  assert.equal(detectCoverageFormat(JACOCO), "jacoco");
  assert.equal(detectCoverageFormat(LCOV), "lcov");
});

test("a JUnit results file is never mistaken for a coverage report", () => {
  // Both are .xml, so filename-based detection would confuse them -- and a
  // results file loaded as coverage would show an empty, silently wrong panel.
  const junit = `<?xml version="1.0"?><testsuites><testsuite name="a">
    <testcase name="t" classname="C" time="0.1"/></testsuite></testsuites>`;
  assert.equal(detectCoverageFormat(junit), null);
  assert.equal(looksLikeCoverage(junit), false);
  assert.equal(parseCoverage(junit), null);

  const trx = `<?xml version="1.0"?><TestRun><Results><UnitTestResult testName="t" outcome="Passed"/></Results></TestRun>`;
  assert.equal(detectCoverageFormat(trx), null);
});

test("parseCoverage returns null for empty or unrecognised input", () => {
  assert.equal(parseCoverage(""), null);
  assert.equal(parseCoverage("not a report at all"), null);
  assert.equal(parseCoverage("<html><body>hi</body></html>"), null);
});

test("parsers survive XML comments, CDATA and entity-escaped paths", () => {
  const hostile = `<coverage>
    <!-- <class filename="ignored.cs"><lines><line number="1" hits="1"/></lines></class> -->
    <packages><package><classes>
      <class filename="a&amp;b/&lt;odd&gt;.cs"><lines><line number="1" hits="1"/></lines></class>
    </classes></package></packages>
  </coverage>`;
  const report = parseCobertura(hostile);
  assert.ok(report);
  assert.equal(report.files.length, 1, "commented-out markup must not be parsed");
  assert.equal(report.files[0].path, "a&b/<odd>.cs", "entities must be unescaped once");
});
