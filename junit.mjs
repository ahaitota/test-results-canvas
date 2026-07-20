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
export function parseJUnit(xml) {
    const text = String(xml || "");
    const results = [];

    // Walk each <testsuite> so we can attach suite-level context (name,
    // timestamp, hostname) to the cases inside it.
    const suiteRe = /<testsuite\b([^>]*?)>([\s\S]*?)<\/testsuite>/g;
    let s;
    let matchedAnySuite = false;
    while ((s = suiteRe.exec(text)) !== null) {
        matchedAnySuite = true;
        const suiteAttrs = s[1] || "";
        const suiteBody = s[2] || "";
        collectCases(suiteBody, {
            suiteName: attr(suiteAttrs, "name"),
            suiteTime: attr(suiteAttrs, "timestamp"),
            suiteHost: attr(suiteAttrs, "hostname"),
        }, results);
    }

    // Some tools emit bare <testcase> elements with no <testsuite> wrapper.
    if (!matchedAnySuite) collectCases(text, {}, results);

    return results;
}

// Extract every <testcase> from a chunk of XML into `results`.
function collectCases(body, ctx, results) {
    const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
    let m;
    while ((m = caseRe.exec(body)) !== null) {
        const attrs = m[1] || "";
        const inner = m[3] || "";

        const name = attr(attrs, "name");
        if (!name) continue;
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
}
