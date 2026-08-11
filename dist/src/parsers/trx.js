// TRX (Visual Studio Test Results) serialize + parse.
//
// TRX is the XML format produced by the Microsoft Testing Platform / `dotnet
// test`. This module converts between our internal result shape
//   { name, status: "pass"|"fail"|"skip", durationMs?, message? }
// and a valid TRX document, so the canvas can persist results to a real .trx
// file and reload them — mocking the output of an actual test run.
const TRX_NS = "http://microsoft.com/schemas/VisualStudio/TeamTest/2010";
// Map our status -> TRX outcome and back.
const STATUS_TO_OUTCOME = { pass: "Passed", fail: "Failed", skip: "NotExecuted" };
function outcomeToStatus(outcome) {
    const o = String(outcome || "").toLowerCase();
    if (o === "passed")
        return "pass";
    if (o === "failed" || o === "error" || o === "timeout")
        return "fail";
    return "skip"; // NotExecuted, Inconclusive, Pending, etc.
}
function xmlEscape(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function xmlUnescape(s) {
    return String(s ?? "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}
// Deterministic pseudo-GUID from a seed so re-serializing the same data is
// stable (avoids noisy diffs). Not cryptographic — just needs to look like a GUID.
function pseudoGuid(seed) {
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
    const a = hex(h);
    const b = hex(Math.imul(h, 2654435761));
    const c = hex(Math.imul(h ^ 0x9e3779b9, 40503));
    const d = hex(Math.imul(h + 0x7f4a7c15, 2246822519));
    return `${a}-${b.slice(0, 4)}-${b.slice(4)}-${c.slice(0, 4)}-${c.slice(4)}${d.slice(0, 4)}`;
}
// milliseconds -> TRX duration "hh:mm:ss.fffffff"
function msToDuration(ms) {
    const totalMs = Math.max(0, Math.round(ms || 0));
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const frac = (totalMs % 1000) * 10000; // 100-ns ticks
    const pad = (n, w) => String(n).padStart(w, "0");
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(frac, 7)}`;
}
// TRX duration "hh:mm:ss.fffffff" -> milliseconds
function durationToMs(dur) {
    const m = /^(\d+):(\d+):(\d+)(?:\.(\d+))?$/.exec(String(dur || "").trim());
    if (!m)
        return undefined;
    const [, h, min, s, frac] = m;
    let ms = (Number(h) * 3600 + Number(min) * 60 + Number(s)) * 1000;
    if (frac)
        ms += Number(("0." + frac)) * 1000;
    return Math.round(ms);
}
// Serialize an array of results into a TRX XML string.
export function serializeTrx(results, opts = {}) {
    const runName = opts.runName || "Test Run";
    const now = (opts.now || new Date()).toISOString();
    const runId = pseudoGuid("run:" + runName);
    const listId = pseudoGuid("list:" + runName);
    const passed = results.filter((r) => r.status === "pass").length;
    const failed = results.filter((r) => r.status === "fail").length;
    const executed = results.filter((r) => r.status !== "skip").length;
    const total = results.length;
    const resultNodes = [];
    const definitionNodes = [];
    const entryNodes = [];
    results.forEach((r, i) => {
        const testId = pseudoGuid("test:" + i + ":" + r.name);
        const execId = pseudoGuid("exec:" + i + ":" + r.name);
        const outcome = STATUS_TO_OUTCOME[r.status] || "NotExecuted";
        const duration = msToDuration(r.durationMs);
        const errorInfo = r.status === "fail" && r.message
            ? `\n        <Output>\n          <ErrorInfo>\n            <Message>${xmlEscape(r.message)}</Message>\n          </ErrorInfo>\n        </Output>\n      `
            : "";
        resultNodes.push(`    <UnitTestResult executionId="${execId}" testId="${testId}" ` +
            `testName="${xmlEscape(r.name)}" computerName="localhost" ` +
            `duration="${duration}" outcome="${outcome}" ` +
            `testListId="${listId}" testType="13cdc9d9-ddb5-4fa4-a97d-d965ccfc6d4b">${errorInfo}</UnitTestResult>`);
        definitionNodes.push(`    <UnitTest name="${xmlEscape(r.name)}" id="${testId}">\n` +
            `      <Execution id="${execId}" />\n` +
            `      <TestMethod codeBase="mock" className="Mock.Tests" name="${xmlEscape(r.name)}" />\n` +
            `    </UnitTest>`);
        entryNodes.push(`    <TestEntry testId="${testId}" executionId="${execId}" testListId="${listId}" />`);
    });
    const overall = failed > 0 ? "Failed" : "Completed";
    return `<?xml version="1.0" encoding="UTF-8"?>
<TestRun id="${runId}" name="${xmlEscape(runName)}" xmlns="${TRX_NS}">
  <Times creation="${now}" queuing="${now}" start="${now}" finish="${now}" />
  <Results>
${resultNodes.join("\n")}
  </Results>
  <TestDefinitions>
${definitionNodes.join("\n")}
  </TestDefinitions>
  <TestEntries>
${entryNodes.join("\n")}
  </TestEntries>
  <TestLists>
    <TestList name="All Results" id="${listId}" />
  </TestLists>
  <ResultSummary outcome="${overall}">
    <Counters total="${total}" executed="${executed}" passed="${passed}" failed="${failed}" ` +
        `error="0" timeout="0" aborted="0" inconclusive="0" notExecuted="${total - executed}" ` +
        `disconnected="0" warning="0" completed="0" inProgress="0" pending="0" />
  </ResultSummary>
</TestRun>
`;
}
// Derive the target framework moniker from a DLL/EXE path, e.g.
//   "...\Debug\net10.0\Foo.dll" -> "net10.0"
//   "...\Debug\net472\Foo.exe"  -> "net472"
function frameworkFromPath(p) {
    const m = /[\\/](net(?:coreapp|standard)?\d[^\\/]*)[\\/]/i.exec(String(p || ""));
    return m ? m[1] : undefined;
}
// Build a testId -> definition map from the <TestDefinitions> section. Each
// <UnitTest> carries the storage (assembly) and a <TestMethod> with the fully
// qualified class name, method name and adapter — none of which live on the
// <UnitTestResult> itself, so we join them by testId.
function parseDefinitions(text) {
    const defs = new Map();
    const re = /<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const utAttrs = m[1] || "";
        const inner = m[2] || "";
        const id = (/\bid="([^"]*)"/.exec(utAttrs) || [])[1];
        if (!id)
            continue;
        const storage = (/\bstorage="([^"]*)"/.exec(utAttrs) || [])[1];
        let className, method, adapter, codeBase;
        const tm = /<TestMethod\b([^>]*?)\/?>/.exec(inner);
        if (tm) {
            const a = tm[1] || "";
            className = (/\bclassName="([^"]*)"/.exec(a) || [])[1];
            method = (/\bname="([^"]*)"/.exec(a) || [])[1];
            adapter = (/\badapterTypeName="([^"]*)"/.exec(a) || [])[1];
            codeBase = (/\bcodeBase="([^"]*)"/.exec(a) || [])[1];
        }
        defs.set(id, {
            className: className ? xmlUnescape(className) : undefined,
            method: method ? xmlUnescape(method) : undefined,
            adapter: adapter ? xmlUnescape(adapter) : undefined,
            storage: storage ? xmlUnescape(storage) : undefined,
            framework: frameworkFromPath(codeBase || storage),
        });
    }
    return defs;
}
// Parse a TRX XML string into an array of our result objects.
// Reads each <UnitTestResult> element (attributes + optional ErrorInfo/Message)
// and enriches it with class/method/framework/adapter from <TestDefinitions>.
export function parseTrx(xml) {
    const results = [];
    const text = String(xml || "");
    const defs = parseDefinitions(text);
    // Match both self-closing and container UnitTestResult elements.
    const re = /<UnitTestResult\b([^>]*?)(\/>|>([\s\S]*?)<\/UnitTestResult>)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const attrs = m[1] || "";
        const inner = m[3] || "";
        const getAttr = (name) => {
            const am = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
            return am ? xmlUnescape(am[1]) : undefined;
        };
        const name = getAttr("testName");
        if (!name)
            continue;
        const outcome = getAttr("outcome");
        const durationMs = durationToMs(getAttr("duration"));
        const testId = getAttr("testId");
        const computerName = getAttr("computerName");
        const startTime = getAttr("startTime");
        const endTime = getAttr("endTime");
        let message;
        const msgM = /<Message>([\s\S]*?)<\/Message>/.exec(inner);
        if (msgM)
            message = xmlUnescape(msgM[1]);
        const stM = /<StackTrace>([\s\S]*?)<\/StackTrace>/.exec(inner);
        if (stM) {
            const st = xmlUnescape(stM[1]).trim();
            message = message ? `${message}\n${st}` : st;
        }
        const def = (testId ? defs.get(testId) : undefined) ?? {};
        results.push({
            name,
            status: outcomeToStatus(outcome),
            durationMs,
            message: message || undefined,
            className: def.className,
            method: def.method,
            framework: def.framework,
            adapter: def.adapter,
            storage: def.storage,
            computerName,
            startTime,
            endTime,
        });
    }
    return results;
}
//# sourceMappingURL=trx.js.map