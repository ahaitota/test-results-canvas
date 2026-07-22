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

function xmlUnescape(s) {
    return String(s ?? "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

// Read an XML attribute value out of a raw tag's attribute string.
function attr(tag, name) {
    const m = new RegExp(`\\b${name}="([^"]*)"`).exec(String(tag || ""));
    return m ? xmlUnescape(m[1]) : undefined;
}

// JUnit "time" is seconds (float) -> milliseconds.
function timeToMs(t) {
    const n = parseFloat(t);
    return Number.isFinite(n) ? Math.round(n * 1000) : undefined;
}

// Parse a JUnit XML string into an array of our result objects.
//
// <testsuite> elements can be *nested* (JUnit 5 Platform Suite Engine,
// composed suites, aggregated reports). A single non-greedy regex cannot
// delimit balanced/nested blocks, so we scan the document with a small tag
// stack: push on each <testsuite ...>, pop on each </testsuite>, and attribute
// every <testcase> to the suite currently on top of the stack (its nearest
// enclosing suite). Cases that sit outside any suite get an empty context,
// which also covers reports that omit <testsuite> entirely.
export function parseJUnit(xml) {
    const text = String(xml || "");
    const results = [];

    const tokenRe =
        /<testsuite\b([^>]*?)(\/?)>|<\/testsuite>|<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
    const suiteStack = [];
    let m;
    while ((m = tokenRe.exec(text)) !== null) {
        if (m[1] !== undefined) {
            // <testsuite ...> opening tag. Skip self-closed suites (no cases).
            if (m[2] !== "/") {
                suiteStack.push({
                    suiteName: attr(m[1], "name"),
                    suiteTime: attr(m[1], "timestamp"),
                    suiteHost: attr(m[1], "hostname"),
                });
            }
        } else if (m[3] !== undefined) {
            // A complete <testcase> element -> nearest enclosing suite.
            const ctx = suiteStack.length ? suiteStack[suiteStack.length - 1] : {};
            emitCase(m[3], m[5] || "", ctx, results);
        } else {
            // </testsuite> -> leave the current suite.
            suiteStack.pop();
        }
    }

    return results;
}

// Turn one <testcase> element (its attribute string + inner body) into a
// result record tagged with the given suite context, and append it.
function emitCase(attrs, inner, ctx, results) {
    const name = attr(attrs, "name");
    if (!name) return;
    const className = attr(attrs, "classname");
    const durationMs = timeToMs(attr(attrs, "time"));

    let status = "pass";
    let message;

    // A <failure> or <error> child marks the test as failing.
    const fail = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(inner);
    const skip = /<skipped\b([^>]*?)(\/>|>([\s\S]*?)<\/skipped>)/.exec(inner);
    if (fail) {
        status = "fail";
        const fType = attr(fail[2], "type");
        const fMsg = attr(fail[2], "message");
        const head = [fType, fMsg].filter(Boolean).join(": ");
        const stack = xmlUnescape(fail[4] || "").trim();
        message = [head, stack].filter(Boolean).join("\n") || undefined;
    } else if (skip) {
        status = "skip";
        const sMsg = attr(skip[1], "message");
        if (sMsg) message = sMsg;
    }

    results.push({
        name,
        status,
        durationMs,
        message,
        className: className || undefined,
        method: name,
        suite: ctx.suiteName,
        startTime: ctx.suiteTime,
        computerName: ctx.suiteHost,
    });
}
