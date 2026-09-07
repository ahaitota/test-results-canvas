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
// A suite that failed in its own right rather than because something under it
// did. NUnit records where the failure happened in `site`: "Child" is the
// aggregate roll-up, while SetUp/TearDown is the suite's own fixture code and
// carries diagnostics no case will ever show.
function ownFailure(el) {
    const site = attr(el.attrs, "site");
    if (!site || site === "Child")
        return false;
    const failure = child(el, "failure");
    return Boolean(childText(failure, "message") || childText(failure, "stack-trace"));
}
// Rows for one element, returning how many of them failed: a suite reports its
// own failure, but an aggregate one only when nothing beneath it already does.
function walk(el, suite, out) {
    let failures = 0;
    for (const c of el.children) {
        if (c.name === "test-case") {
            emit(c, suite, out);
            if (out[out.length - 1]?.status === "fail")
                failures++;
            continue;
        }
        if (c.name !== "test-suite") {
            failures += walk(c, suite, out);
            continue;
        }
        const inner = walk(c, attr(c.attrs, "name") ?? suite, out);
        // OneTimeTearDown can fail independently of a test that already failed,
        // and a fixture that blows up in OneTimeSetUp -- or an assembly that
        // fails to load -- has no case to carry its failure at all.
        if (ownFailure(c) || (!inner && status(attr(c.attrs, "result")) === "fail")) {
            emit(c, suite, out);
            failures++;
        }
        failures += inner;
    }
    return failures;
}
export function parseNUnit(xml) {
    const out = [];
    walk(parseXml(xml), undefined, out);
    return out;
}
//# sourceMappingURL=nunit.js.map