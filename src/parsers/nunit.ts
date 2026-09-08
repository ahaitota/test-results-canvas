// NUnit 3 result XML: <test-run> / nested <test-suite> / <test-case>.

import type { TestResult, TestStatus } from "../types.js";
import { attr, parseXml, child, childText } from "../xml.js";
import type { XmlElement } from "../xml.js";
import { joinMessage } from "./json.js";

function status(result: string | undefined): TestStatus {
    const r = String(result || "").toLowerCase();
    // NUnit 2 spells the same outcomes Success/Failure on <test-case>.
    if (r === "passed" || r === "success") return "pass";
    if (r === "failed" || r === "failure" || r === "error") return "fail";
    // A warning is a test that ran and did not fail; counting it as skipped
    // would take it out of the pass rate it belongs in. Its diagnostics are
    // kept on the row.
    if (r === "warning") return "pass";
    return "skip";
}

function seconds(value: string | undefined): number | undefined {
    const n = parseFloat(value ?? "");
    return Number.isFinite(n) ? Math.round(n * 1000) : undefined;
}

function emit(el: XmlElement, suite: string | undefined, out: TestResult[]): void {
    const name = attr(el.attrs, "name");
    if (!name) return;
    const failure = child(el, "failure");
    const detail = failure ?? child(el, "reason");
    // A warning records itself as an assertion rather than a reason, and that
    // text is the only account of what it warned about.
    const assertion = child(child(el, "assertions"), "assertion");
    out.push({
        name,
        status: status(attr(el.attrs, "result")),
        durationMs: seconds(attr(el.attrs, "duration") ?? attr(el.attrs, "time")),
        message: joinMessage(childText(detail, "message") ?? childText(assertion, "message"), childText(failure, "stack-trace")),
        className: attr(el.attrs, "classname"),
        method: attr(el.attrs, "methodname") ?? name,
        suite,
        framework: "NUnit",
        startTime: attr(el.attrs, "start-time"),
        endTime: attr(el.attrs, "end-time"),
    });
}

// Where NUnit says a failure happened. Only SetUp and TearDown are the suite's
// OWN fixture code: "Child" and "Parent" are roll-ups of a failure something
// else already reports, and "Test" belongs to the cases beneath. Allow-listed
// rather than excluded, so a site this does not know cannot pass for the
// suite's own failure.
function site(el: XmlElement): string {
    return (attr(el.attrs, "site") ?? "").toLowerCase();
}

// A suite that failed in its own fixture code, with diagnostics no case will
// ever carry.
function ownFailure(el: XmlElement): boolean {
    const where = site(el);
    if (where !== "setup" && where !== "teardown") return false;
    const failure = child(el, "failure");
    return Boolean(childText(failure, "message") || childText(failure, "stack-trace"));
}

// Rows for one element, returning how many of them failed: a suite reports its
// own fixture failure, but one inherited from elsewhere is left to the suite
// that owns it, and an unattributed one only when nothing beneath it failed.
function walk(el: XmlElement, suite: string | undefined, out: TestResult[]): number {
    let failures = 0;
    for (const c of el.children) {
        if (c.name === "test-case") {
            emit(c, suite, out);
            if (out[out.length - 1]?.status === "fail") failures++;
            continue;
        }
        if (c.name !== "test-suite") {
            failures += walk(c, suite, out);
            continue;
        }
        const inner = walk(c, attr(c.attrs, "name") ?? suite, out);
        const inherited = site(c) === "parent" || site(c) === "child";
        const failed = status(attr(c.attrs, "result")) === "fail";
        // OneTimeTearDown can fail independently of a test that already failed,
        // and a fixture that blows up in OneTimeSetUp -- or an assembly that
        // fails to load -- has no case to carry its failure at all.
        if (ownFailure(c) || (failed && !inherited && !inner)) {
            emit(c, suite, out);
            failures++;
        }
        failures += inner;
    }
    return failures;
}

export function parseNUnit(xml: string): TestResult[] {
    const root = parseXml(xml);
    const out: TestResult[] = [];
    walk(root, undefined, out);
    // Nothing beneath owned the failure, which a report can manage when the run
    // failed before any suite did. Better one row saying so than an empty run
    // that reads as green.
    if (!out.length) {
        const run = child(root, "test-run") ?? child(root, "test-results");
        if (run && status(attr(run.attrs, "result")) === "fail") {
            const failure = child(run, "failure");
            out.push({
                name: attr(run.attrs, "name") ?? "test run",
                status: "fail",
                message: joinMessage(childText(failure, "message"), childText(failure, "stack-trace")),
                framework: "NUnit",
            });
        }
    }
    return out;
}
