// NUnit 3 result XML: <test-run> / nested <test-suite> / <test-case>.
import { attr, parseXml, child, childText } from "../xml.js";
import { joinMessage } from "./json.js";
function status(result) {
    const r = String(result || "").toLowerCase();
    // NUnit 2 spells the same outcomes Success/Failure on <test-case>.
    if (r === "passed" || r === "success")
        return "pass";
    if (r === "failed" || r === "failure" || r === "error")
        return "fail";
    return "skip";
}
function seconds(value) {
    const n = parseFloat(value ?? "");
    return Number.isFinite(n) ? Math.round(n * 1000) : undefined;
}
function emit(el, suite, out) {
    const name = attr(el.attrs, "name");
    if (!name)
        return;
    const failure = child(el, "failure");
    const detail = failure ?? child(el, "reason");
    out.push({
        name,
        status: status(attr(el.attrs, "result")),
        durationMs: seconds(attr(el.attrs, "duration") ?? attr(el.attrs, "time")),
        message: joinMessage(childText(detail, "message"), childText(failure, "stack-trace")),
        className: attr(el.attrs, "classname"),
        method: attr(el.attrs, "methodname") ?? name,
        suite,
        framework: "NUnit",
        startTime: attr(el.attrs, "start-time"),
        endTime: attr(el.attrs, "end-time"),
    });
}
function walk(el, suite, out) {
    for (const c of el.children) {
        if (c.name === "test-case") {
            emit(c, suite, out);
            continue;
        }
        walk(c, c.name === "test-suite" ? attr(c.attrs, "name") ?? suite : suite, out);
    }
}
export function parseNUnit(xml) {
    const out = [];
    walk(parseXml(xml), undefined, out);
    return out;
}
//# sourceMappingURL=nunit.js.map