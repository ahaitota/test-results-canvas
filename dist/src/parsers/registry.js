// The parser registry: every supported report format, matched on content rather
// than on a file name, so a `.xml` that is really NUnit is never read as JUnit.
//
// Order is specificity, not preference: the first parser whose signature appears
// in the file's head wins, so add narrower dialects above broader ones.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { HEAD_BYTES, readHead } from "../head.js";
import { attr, rootTag, hasElement, isWellFormed } from "../xml.js";
import { topLevelFields } from "./json.js";
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
// Shared by the XML dialects: same extension, same structural gate.
const XML = { exts: [".xml"], wellFormed: isWellFormed };
const JSONL = [".json", ".jsonl", ".ndjson"];
// The document's opening element, lowercased. Everything else in the file --
// text, attributes, comments, CDATA -- is content, and content must never be
// able to name a parser.
function root(head, ...names) {
    const name = rootTag(head)?.name.toLowerCase();
    return name !== undefined && names.includes(name);
}
const ALLURE_STATUS = new Set(["passed", "failed", "broken", "skipped", "unknown"]);
// An Allure *result*: its own status and name at the top level. A container
// (`*-container.json`) has a uuid and a name too, but its statuses belong to the
// fixtures nested inside it.
function isAllureResult(head) {
    const top = topLevelFields(head);
    if (!top.has("uuid") || !ALLURE_STATUS.has(top.get("status") ?? ""))
        return false;
    return top.has("name") || top.has("fullName");
}
export const PARSERS = [
    { id: "trx", ...XML, exts: [".trx", ".xml"], detect: (h) => root(h, "testrun", "unittestresult"), parse: parseTrx },
    { id: "junit", ...XML, detect: (h) => root(h, "testsuites", "testsuite"), parse: parseJUnit },
    { id: "nunit", ...XML, detect: (h) => root(h, "test-run", "test-results", "test-suite"), parse: parseNUnit },
    { id: "xunit", ...XML, detect: (h) => root(h, "assemblies") || (root(h, "assembly") && attr(rootTag(h)?.attrs, "test-framework") !== undefined), parse: parseXunit },
    { id: "testng", ...XML, detect: (h) => root(h, "testng-results"), parse: parseTestNG },
    // <Site> is also the root of CTest's Build.xml and Coverage.xml, so the
    // testing section has to be there as well.
    { id: "ctest", ...XML, detect: (h) => root(h, "site") && hasElement(h, "Testing"), parse: parseCTest },
    // CTRF needs a marker it owns: Playwright's JSON report nests "results" and
    // "tests" too.
    { id: "ctrf", exts: [".json"], detect: (h) => /"reportFormat"\s*:\s*"CTRF"/i.test(h) || (/"tool"\s*:\s*\{/.test(h) && /"tests"\s*:\s*\[/.test(h)), parse: parseCtrf },
    { id: "allure", exts: [".json"], detect: isAllureResult, parse: parseAllure, expand: expandAllure },
    { id: "gotest", exts: JSONL, detect: (h) => /"Action"\s*:\s*"(run|output|pass|fail|skip|build-output|build-fail)"/.test(h), parse: parseGoTest },
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
    if (parser.wellFormed && !parser.wellFormed(text))
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
    if (parser.wellFormed && !parser.wellFormed(text))
        return null;
    try {
        if (!parser.expand)
            return parser.parse(text);
        const rows = [];
        // No per-file tolerance: an Allure run is the whole folder, so a sibling
        // that is unreadable or caught mid-write makes the aggregate a subset of
        // the run -- and a subset presented as the run is a green report of an
        // outcome nobody knows yet. Failing here leaves the last complete run on
        // screen until the folder is readable again.
        for (const file of parser.expand(abs))
            rows.push(...parser.parse(file === abs ? text : readFileSync(file, "utf8")));
        return rows;
    }
    catch {
        return null;
    }
}
// True when this path's format takes in its whole directory, so any qualifying
// sibling is part of the same source.
export function expandsDirectory(abs) {
    try {
        return detectParser(readHead(abs))?.expand !== undefined;
    }
    catch {
        return false;
    }
}
// What makes two paths the same run. A format that expands around a file covers
// its whole folder, so every result in an Allure directory shares one key:
// adding them as separate sources would parse the set once per member and merge
// N copies of every row.
export function runKey(abs) {
    return expandsDirectory(abs) ? `expanded\u0000${dirname(abs)}` : abs;
}
// The paths that name distinct runs, in the order given.
export function canonicalResultPaths(paths) {
    const seen = new Set();
    return paths.filter((abs) => {
        const key = runKey(abs);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
//# sourceMappingURL=registry.js.map