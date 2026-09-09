// The parser registry: every supported report format, matched on content rather
// than on a file name, so a `.xml` that is really NUnit is never read as JUnit.
//
// Order is specificity, not preference: the first parser whose signature appears
// in the file's head wins, so add narrower dialects above broader ones.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { TestResult } from "../types.js";
import { HEAD_BYTES, readHead } from "../head.js";
import { attr, rootTag, hasElement, isWellFormed } from "../xml.js";
import { topLevelFields, firstJsonObject, rec } from "./json.js";
import { parseTrx } from "./trx.js";
import { parseJUnit } from "./junit.js";
import { parseNUnit } from "./nunit.js";
import { parseXunit } from "./xunit.js";
import { parseTestNG } from "./testng.js";
import { parseCTest } from "./ctest.js";
import { parseCtrf } from "./ctrf.js";
import { parseAllure, expandAllure, isAllureRunFile, ALLURE_STATUS } from "./allure.js";
import { parseGoTest } from "./gotest.js";
import { parseDart } from "./dart.js";
import { parseRustJson } from "./rust.js";
import { parseTap } from "./tap.js";

export interface Parser {
    id: string;
    // Extensions the format is discovered under. Explicitly named files are
    // sniffed whatever they are called; this only bounds directory scans.
    exts: readonly string[];
    detect(head: string): boolean;
    parse(text: string): TestResult[];
    // Rejects a structurally incomplete document before it is parsed, so a
    // report caught half-written cannot replace a finished run with the rows
    // that happened to be flushed. Head-only callers skip it: a head is
    // truncated by definition.
    wellFormed?(text: string): boolean;
    // Sibling files that form the same run (Allure writes one file per test).
    expand?(abs: string): string[];
    // Whether `expand` groups THIS file with its folder. A format can do that
    // for its own naming only, and a file it does not group is its own run.
    groups?(abs: string): boolean;
}

// Shared by the XML dialects: same extension, same structural gate.
const XML = { exts: [".xml"], wellFormed: isWellFormed };
const JSONL = [".json", ".jsonl", ".ndjson"];

// The document's opening element, lowercased. Everything else in the file --
// text, attributes, comments, CDATA -- is content, and content must never be
// able to name a parser.
function root(head: string, ...names: string[]): boolean {
    const name = rootTag(head)?.name.toLowerCase();
    return name !== undefined && names.includes(name);
}

const ALLURE_STATUS_VALUES = ALLURE_STATUS;

// An Allure *result*: its own status and name at the top level. A container
// (`*-container.json`) has a uuid and a name too, but its statuses belong to the
// fixtures nested inside it.
function isAllureResult(head: string): boolean {
    const top = topLevelFields(head);
    if (!top.has("uuid") || !ALLURE_STATUS_VALUES.has(top.get("status") ?? "")) return false;
    return top.has("name") || top.has("fullName");
}

// The event streams are one JSON object per line, so what a document IS can be
// read off its first object. Searching the raw text instead would let a key
// nested in some unrelated JSON -- `{"metadata":{"Action":"pass"}}` -- claim
// the file and blank the panel with an empty run.
const GO_ACTIONS = new Set(["start", "run", "output", "pass", "fail", "skip", "build-output", "build-fail"]);
// Dart's own event names. "suite" is deliberately not among them: Rust opens
// with a "suite" event too, and the two are told apart below by what the event
// carries rather than by which parser is asked first.
const DART_TYPES = new Set(["start", "testStart", "testDone", "allSuites", "group"]);
const RUST_TYPES = new Set(["suite", "test", "bench"]);

function isGoEvent(head: string): boolean {
    const first = firstJsonObject(head);
    return typeof first?.Action === "string" && GO_ACTIONS.has(first.Action);
}

function isDartEvent(head: string): boolean {
    const first = firstJsonObject(head);
    if (!first) return false;
    if (typeof first.protocolVersion === "string") return true;
    if (typeof first.type !== "string") return false;
    // Dart's suite event carries the suite it describes; Rust's carries an
    // outcome.
    return DART_TYPES.has(first.type) || (first.type === "suite" && rec(first.suite) !== undefined);
}

function isRustEvent(head: string): boolean {
    const first = firstJsonObject(head);
    // Key order is the runner's business, so the pair is read as fields rather
    // than matched as adjacent text.
    return typeof first?.type === "string" && RUST_TYPES.has(first.type) && typeof first.event === "string";
}

export const PARSERS: readonly Parser[] = [
    { id: "trx", ...XML, exts: [".trx", ".xml"], detect: (h) => root(h, "testrun", "unittestresult"), parse: parseTrx },
    { id: "junit", ...XML, detect: (h) => root(h, "testsuites", "testsuite"), parse: parseJUnit },
    { id: "nunit", ...XML, detect: (h) => root(h, "test-run", "test-results", "test-suite"), parse: parseNUnit },
    { id: "xunit", ...XML, detect: (h) => root(h, "assemblies") || (root(h, "assembly") && attr(rootTag(h)?.attrs, "test-framework") !== undefined), parse: parseXunit },
    { id: "testng", ...XML, detect: (h) => root(h, "testng-results"), parse: parseTestNG },
    // <Site> is also the root of CTest's Build.xml and Coverage.xml, so the
    // testing section has to be there as well.
    { id: "ctest", ...XML, detect: (h) => root(h, "site") && hasElement(h, "Testing"), parse: parseCTest },
    // CTRF names itself. The nested tool/tests shape alone is not enough: an
    // application's own JSON can hold both and would blank the panel.
    { id: "ctrf", exts: [".json"], detect: (h) => (topLevelFields(h).get("reportFormat") ?? "").toUpperCase() === "CTRF", parse: parseCtrf },
    { id: "allure", exts: [".json"], detect: isAllureResult, parse: parseAllure, expand: expandAllure, groups: isAllureRunFile },
    { id: "gotest", exts: JSONL, detect: isGoEvent, parse: parseGoTest },
    { id: "dart", exts: JSONL, detect: isDartEvent, parse: parseDart },
    { id: "rust", exts: JSONL, detect: isRustEvent, parse: parseRustJson },
    { id: "tap", exts: [".tap"], detect: (h) => /^\s*TAP version \d/im.test(h) || (/^\s*\d+\.\.\d+\s*$/m.test(h) && /^\s*(not\s+)?ok\b/m.test(h)), parse: parseTap },
];

// Extensions a directory scan will even look at.
export const RESULT_EXTS: readonly string[] = [...new Set(PARSERS.flatMap((p) => p.exts))];

// A UTF-8 BOM decodes to a leading U+FEFF that is not part of the document:
// XML validation would see it as content outside the root, and JSON.parse
// rejects it outright. Windows tooling writes it routinely, so it is stripped
// once here rather than guarded against in every parser.
function withoutBom(text: string): string {
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

// The parser that claims this content, or undefined. `scope` is how much of it
// to look at: a directory scan only ever reads the opening bytes of a
// candidate, but a file that has already been read whole is matched against all
// of it -- a report can carry a long leading comment or metadata field and be
// perfectly valid. The head is still tried first, so the full sweep costs
// nothing until it is the difference between reading a file and rejecting it.
export function detectParser(text: unknown, scope: "head" | "full" = "head"): Parser | undefined {
    const body = withoutBom(String(text || ""));
    const head = body.slice(0, HEAD_BYTES);
    const found = PARSERS.find((p) => p.detect(head));
    if (found || scope === "head" || body.length <= head.length) return found;
    return PARSERS.find((p) => p.detect(body));
}

export function looksLikeResults(text: unknown): boolean {
    return detectParser(text) !== undefined;
}

// Rows from an in-memory report, or null when nothing claims it or the claimed
// format turns out to be malformed -- so a broken file is reported as "not a
// report" rather than rendered as a run in which no test failed.
export function parseResults(text: string): TestResult[] | null {
    const body = withoutBom(String(text || ""));
    const parser = detectParser(body, "full");
    if (!parser) return null;
    if (parser.wellFormed && !parser.wellFormed(body)) return null;
    try {
        return parser.parse(body);
    } catch {
        return null;
    }
}

// Same, for a path on disk, expanding multi-file formats around it.
export function parseResultsAt(abs: string): TestResult[] | null {
    let text: string;
    try {
        text = withoutBom(readFileSync(abs, "utf8"));
    } catch {
        return null;
    }
    const parser = detectParser(text, "full");
    if (!parser) return null;
    if (parser.wellFormed && !parser.wellFormed(text)) return null;
    try {
        if (!parser.expand) return parser.parse(text);
        const rows: TestResult[] = [];
        // No per-file tolerance: an Allure run is the whole folder, so a sibling
        // that is unreadable or caught mid-write makes the aggregate a subset of
        // the run -- and a subset presented as the run is a green report of an
        // outcome nobody knows yet. Failing here leaves the last complete run on
        // screen until the folder is readable again.
        for (const file of parser.expand(abs)) rows.push(...parser.parse(file === abs ? text : withoutBom(readFileSync(file, "utf8"))));
        return rows;
    } catch {
        return null;
    }
}

// True when this path's format takes in its whole directory, so any qualifying
// sibling is part of the same source. Asked of the FILE, not just the format:
// Allure groups its own `<uuid>-result.json` naming, and a report that happens
// to be Allure JSON under another name stands alone.
export function expandsDirectory(abs: string): boolean {
    const parser = detectAt(abs);
    if (!parser?.expand) return false;
    return parser.groups?.(abs) ?? true;
}

// The parser that claims the file at `abs`, read from its head alone.
function detectAt(abs: string): Parser | undefined {
    try {
        return detectParser(readHead(abs));
    } catch {
        return undefined;
    }
}

// Which format a file on disk is, or undefined when nothing claims it. Lets a
// caller keep a source on the kind of report it started as. `scope` matches
// detectParser: a scan judges the head, while a file being opened as a source
// is read whole, so a report whose format only shows up later still has one.
export function formatIdAt(abs: string, scope: "head" | "full" = "head"): string | undefined {
    if (scope === "head") return detectAt(abs)?.id;
    try {
        return detectParser(readFileSync(abs, "utf8"), "full")?.id;
    } catch {
        return undefined;
    }
}

// One key per file, whatever spelling the caller used. A symlink, a Windows
// 8.3 short name or a mixed-case alias on a case-insensitive filesystem all
// name the same run -- keying on the raw string would add the same report twice
// and double every row it holds.
//
// The canonical spelling comes from the filesystem rather than from folding
// case by platform: `realpathSync.native` returns the real on-disk name, which
// collapses an alias exactly where the volume treats it as one, and leaves
// genuinely distinct names alone on a case-SENSITIVE volume -- which macOS can
// be formatted as. Only the KEY is canonical: the path a source is read from
// and displayed under stays exactly as it was given.
export function canonicalPath(p: string): string {
    const resolved = resolve(p);
    try {
        return realpathSync.native(resolved);
    } catch {
        // Not on disk yet, so the spelling given is all there is to go on.
        return resolved;
    }
}

// What makes two paths the same run. A format that expands around a file covers
// its whole folder, so every result in an Allure directory shares one key:
// adding them as separate sources would parse the set once per member and merge
// N copies of every row.
export function runKey(abs: string): string {
    return expandsDirectory(abs) ? `expanded\u0000${canonicalPath(dirname(abs))}` : canonicalPath(abs);
}

// The paths that name distinct runs, in the order given.
export function canonicalResultPaths(paths: readonly string[]): string[] {
    const seen = new Set<string>();
    return paths.filter((abs) => {
        const key = runKey(abs);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
