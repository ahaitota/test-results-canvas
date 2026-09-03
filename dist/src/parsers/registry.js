// The parser registry: every supported report format, matched on content rather
// than on a file name, so a `.xml` that is really NUnit is never read as JUnit.
//
// Order is specificity, not preference: the first parser whose signature appears
// in the file's head wins, so add narrower dialects above broader ones.
import { readFileSync } from "node:fs";
import { HEAD_BYTES } from "../head.js";
import { parseTrx } from "./trx.js";
import { parseJUnit } from "./junit.js";
import { parseNUnit } from "./nunit.js";
import { parseXunit } from "./xunit.js";
import { parseTestNG } from "./testng.js";
import { parseCTest } from "./ctest.js";
import { parseCtrf } from "./ctrf.js";
import { parseAllure, expandAllure } from "./allure.js";
import { parseGoTest } from "./gotest.js";
import { parseDart } from "./dart.js";
import { parseRustJson } from "./rust.js";
import { parseTap } from "./tap.js";
const XML = [".xml"];
const JSONL = [".json", ".jsonl", ".ndjson"];
export const PARSERS = [
    { id: "trx", exts: [".trx", ".xml"], detect: (h) => /<TestRun[\s>]/i.test(h) || /<UnitTestResult[\s>]/i.test(h), parse: parseTrx },
    { id: "junit", exts: XML, detect: (h) => /<testsuites?[\s>]/i.test(h), parse: parseJUnit },
    { id: "nunit", exts: XML, detect: (h) => /<test-(run|results|suite)[\s>]/i.test(h), parse: parseNUnit },
    { id: "xunit", exts: XML, detect: (h) => /<assemblies[\s>]/i.test(h) || /<assembly[^>]*\stest-framework=/i.test(h), parse: parseXunit },
    { id: "testng", exts: XML, detect: (h) => /<testng-results[\s>]/i.test(h), parse: parseTestNG },
    { id: "ctest", exts: XML, detect: (h) => /<Testing[\s>]/.test(h), parse: parseCTest },
    // Both JSON predicates need a marker the format actually owns: Playwright's
    // report nests "results"/"tests" too, and Jest/Vitest --json carry
    // "fullName" with an Allure-shaped "status".
    { id: "ctrf", exts: [".json"], detect: (h) => /"reportFormat"\s*:\s*"CTRF"/i.test(h) || (/"tool"\s*:\s*\{/.test(h) && /"tests"\s*:\s*\[/.test(h)), parse: parseCtrf },
    { id: "allure", exts: [".json"], detect: (h) => /"uuid"\s*:/.test(h) && /"status"\s*:\s*"(passed|failed|broken|skipped|unknown)"/.test(h), parse: parseAllure, expand: expandAllure },
    { id: "gotest", exts: JSONL, detect: (h) => /"Action"\s*:\s*"(run|output|pass|fail|skip)"/.test(h), parse: parseGoTest },
    { id: "dart", exts: JSONL, detect: (h) => /"type"\s*:\s*"(testStart|testDone)"/.test(h) || /"protocolVersion"\s*:/.test(h), parse: parseDart },
    { id: "rust", exts: JSONL, detect: (h) => /"type"\s*:\s*"(suite|test)"\s*,\s*"event"\s*:/.test(h), parse: parseRustJson },
    { id: "tap", exts: [".tap"], detect: (h) => /^\s*TAP version \d/im.test(h) || (/^\s*\d+\.\.\d+\s*$/m.test(h) && /^\s*(not\s+)?ok\b/m.test(h)), parse: parseTap },
];
// Extensions a directory scan will even look at.
export const RESULT_EXTS = [...new Set(PARSERS.flatMap((p) => p.exts))];
// The parser that claims this content, or undefined. Only the head is examined:
// a scan sniffs the first bytes of a candidate rather than reading it whole.
export function detectParser(text) {
    const head = String(text || "").slice(0, HEAD_BYTES);
    return PARSERS.find((p) => p.detect(head));
}
export function looksLikeResults(text) {
    return detectParser(text) !== undefined;
}
// Rows from an in-memory report, or null when nothing claims it or the claimed
// format turns out to be malformed -- so a broken file is reported as "not a
// report" rather than rendered as a run in which no test failed.
export function parseResults(text) {
    const parser = detectParser(text);
    if (!parser)
        return null;
    try {
        return parser.parse(text);
    }
    catch {
        return null;
    }
}
// Same, for a path on disk, expanding multi-file formats around it.
export function parseResultsAt(abs) {
    let text;
    try {
        text = readFileSync(abs, "utf8");
    }
    catch {
        return null;
    }
    const parser = detectParser(text);
    if (!parser)
        return null;
    try {
        if (!parser.expand)
            return parser.parse(text);
        const rows = [];
        // Per file: an Allure run writes one result file per test while it runs,
        // so a sibling caught mid-write must cost one row, not the whole run.
        for (const file of parser.expand(abs)) {
            try {
                rows.push(...parser.parse(file === abs ? text : readFileSync(file, "utf8")));
            }
            catch { /* skip the unreadable sibling */ }
        }
        return rows;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=registry.js.map