// JUnit XML parser.
//
// JUnit is the de-facto test-report format emitted by most CI systems and test
// runners (Java's JUnit/Surefire, pytest --junitxml, jest-junit, Go's
// go-junit-report, etc.). This module converts a JUnit document into the same
// internal result shape the canvas already renders:
//   { name, status: "pass"|"fail"|"skip", durationMs?, message?, className?,
//     method?, suite?, startTime?, computerName? }
//
// Structure it handles:
//   <testsuites>            (optional wrapper for multiple suites)
//     <testsuite name="..." timestamp="..." hostname="...">
//       <testcase name="..." classname="..." time="0.042" />          -> pass
//       <testcase ...><failure message="..." type="...">stack</failure></testcase>
//       <testcase ...><error   message="..." type="...">stack</error></testcase>
//       <testcase ...><skipped message="..." /></testcase>            -> skip
//     </testsuite>
//   </testsuites>
import { attr, xmlUnescape } from "../xml.js";
// JUnit "time" is seconds (float) -> milliseconds.
function timeToMs(t) {
    const n = parseFloat(t ?? "");
    return Number.isFinite(n) ? Math.round(n * 1000) : undefined;
}
// Parse a JUnit XML string into an array of our result objects.
//
// <testsuite> elements can be *nested*, so a single regex can't delimit them.
// We scan the document as XML with a small tokenizer: keep a stack of open
// <testsuite>s and attribute each <testcase> to the suite on top (its nearest
// enclosing suite); cases outside any suite get an empty context (also covers
// reports with no <testsuite>). Scanning as XML also lets us skip comments and
// CDATA (their contents are data, not elements) and accept whitespace in end
// tags, e.g. "</testsuite >".
export function parseJUnit(xml) {
    const text = String(xml || "");
    const results = [];
    const suiteStack = [];
    let i = 0;
    while (i < text.length) {
        const lt = text.indexOf("<", i);
        if (lt < 0)
            break;
        // Comments and CDATA are opaque: never scan their contents as markup.
        if (text.startsWith("<!--", lt)) {
            i = skipPast(text, lt + 4, "-->");
            continue;
        }
        if (text.startsWith("<![CDATA[", lt)) {
            i = skipPast(text, lt + 9, "]]>");
            continue;
        }
        // </testsuite ...> closes the nearest open suite.
        const closed = matchCloseTag(text, lt, "testsuite");
        if (closed >= 0) {
            suiteStack.pop();
            i = closed;
            continue;
        }
        // <testsuite ...> opens a suite (self-closed ones hold no cases).
        const suite = matchOpenTag(text, lt, "testsuite");
        if (suite) {
            if (!suite.selfClosing) {
                suiteStack.push({
                    suiteName: attr(suite.attrs, "name"),
                    suiteTime: attr(suite.attrs, "timestamp"),
                    suiteHost: attr(suite.attrs, "hostname"),
                });
            }
            i = suite.end;
            continue;
        }
        // <testcase ...> ... </testcase> (or self-closed) -> nearest suite.
        const tc = matchOpenTag(text, lt, "testcase");
        if (tc) {
            const ctx = suiteStack.length ? suiteStack[suiteStack.length - 1] : {};
            if (tc.selfClosing) {
                emitCase(tc.attrs, "", ctx, results);
                i = tc.end;
            }
            else {
                // Real </testcase>, skipping any inside comments/CDATA.
                const close = findCloseTag(text, tc.end, "testcase");
                const bodyEnd = close.start >= 0 ? close.start : text.length;
                emitCase(tc.attrs, text.slice(tc.end, bodyEnd), ctx, results);
                i = close.after >= 0 ? close.after : text.length;
            }
            continue;
        }
        // Any other tag (<testsuites>, <properties>, ...): step over this "<".
        i = lt + 1;
    }
    return results;
}
// Index just past `marker` (from `from`), or end of string — jumps over
// comment/CDATA runs.
function skipPast(text, from, marker) {
    const idx = text.indexOf(marker, from);
    return idx < 0 ? text.length : idx + marker.length;
}
// Index of the ">" that ends the tag opened at `i`, or -1. Only "<" and "&" must
// be escaped in XML, so a ">" is legal inside an attribute value (a test named
// "...before '>' in a tag" is common). Skipping quoted spans keeps such a ">"
// from cutting the tag short — which would hide the case and, because the stub
// no longer looks self-closing, swallow every element up to the next close tag.
function findTagEnd(text, i) {
    let quote = "";
    for (let j = i + 1; j < text.length; j++) {
        const ch = text[j];
        if (quote) {
            if (ch === quote)
                quote = "";
        }
        else if (ch === '"' || ch === "'") {
            quote = ch;
        }
        else if (ch === ">") {
            return j;
        }
    }
    return -1;
}
// Match "<name ...>" / self-closing "<name .../>" at i -> { attrs, end,
// selfClosing } or null. The char after `name` must be space, "/" or ">" so
// "testsuites" isn't mistaken for "testsuite".
function matchOpenTag(text, i, name) {
    if (text[i] !== "<" || !text.startsWith(name, i + 1))
        return null;
    const after = text[i + 1 + name.length];
    if (after !== ">" && after !== "/" && !/\s/.test(after ?? ""))
        return null;
    const gt = findTagEnd(text, i);
    if (gt < 0)
        return null;
    let raw = text.slice(i + 1 + name.length, gt);
    const selfClosing = raw.trimEnd().endsWith("/");
    if (selfClosing)
        raw = raw.trimEnd().slice(0, -1);
    return { attrs: raw, end: gt + 1, selfClosing };
}
// Match "</name>" at i, tolerating whitespace before ">" -> index past ">", or -1.
function matchCloseTag(text, i, name) {
    if (!text.startsWith("</", i) || !text.startsWith(name, i + 2))
        return -1;
    let j = i + 2 + name.length;
    while (j < text.length && /\s/.test(text[j]))
        j++;
    if (text[j] !== ">")
        return -1;
    return j + 1;
}
// Find the matching "</name>" from `from`, skipping comments/CDATA so a literal
// "</name>" inside them doesn't end the element early. -> { start, after }
// (indices of "</name" and past ">"; both -1 if not found).
function findCloseTag(text, from, name) {
    let i = from;
    while (i < text.length) {
        const lt = text.indexOf("<", i);
        if (lt < 0)
            break;
        if (text.startsWith("<!--", lt)) {
            i = skipPast(text, lt + 4, "-->");
            continue;
        }
        if (text.startsWith("<![CDATA[", lt)) {
            i = skipPast(text, lt + 9, "]]>");
            continue;
        }
        const after = matchCloseTag(text, lt, name);
        if (after >= 0)
            return { start: lt, after };
        i = lt + 1;
    }
    return { start: -1, after: -1 };
}
// First child element named in `names` (document order), skipping comments and
// CDATA. Uses the same quote-aware tag scan as the main loop, so a ">" inside a
// message/type attribute can't truncate the tag and lose the failure text.
function findChild(inner, names) {
    let i = 0;
    while (i < inner.length) {
        const lt = inner.indexOf("<", i);
        if (lt < 0)
            break;
        if (inner.startsWith("<!--", lt)) {
            i = skipPast(inner, lt + 4, "-->");
            continue;
        }
        if (inner.startsWith("<![CDATA[", lt)) {
            i = skipPast(inner, lt + 9, "]]>");
            continue;
        }
        for (const name of names) {
            const tag = matchOpenTag(inner, lt, name);
            if (!tag)
                continue;
            if (tag.selfClosing)
                return { attrs: tag.attrs, body: "" };
            const close = findCloseTag(inner, tag.end, name);
            return { attrs: tag.attrs, body: inner.slice(tag.end, close.start >= 0 ? close.start : inner.length) };
        }
        i = lt + 1;
    }
    return null;
}
// Turn one <testcase> element (its attribute string + inner body) into a
// result record tagged with the given suite context, and append it.
function emitCase(attrs, inner, ctx, results) {
    const name = attr(attrs, "name");
    if (!name)
        return;
    const className = attr(attrs, "classname");
    const durationMs = timeToMs(attr(attrs, "time"));
    // Optional, and only some runners write it, but when it is there it is the
    // only unambiguous link from a test to a source path.
    const file = attr(attrs, "file");
    let status = "pass";
    let message;
    // A <failure> or <error> child marks the test as failing.
    const fail = findChild(inner, ["failure", "error"]);
    const skip = findChild(inner, ["skipped"]);
    if (fail) {
        status = "fail";
        const fType = attr(fail.attrs, "type");
        const fMsg = attr(fail.attrs, "message");
        const head = [fType, fMsg].filter(Boolean).join(": ");
        const stack = xmlUnescape(fail.body).trim();
        message = [head, stack].filter(Boolean).join("\n") || undefined;
    }
    else if (skip) {
        status = "skip";
        const sMsg = attr(skip.attrs, "message");
        if (sMsg)
            message = sMsg;
    }
    results.push({
        name,
        status,
        durationMs,
        message,
        className: className || undefined,
        method: name,
        suite: ctx.suiteName,
        file: file || undefined,
        startTime: ctx.suiteTime,
        computerName: ctx.suiteHost,
    });
}
//# sourceMappingURL=junit.js.map