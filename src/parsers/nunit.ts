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

// Rows for one element, returning how many of them failed: a suite that failed
// on its own reports that only when nothing beneath it already does.
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
        // A fixture that blows up in OneTimeSetUp, or an assembly that fails to
        // load, carries its <failure> on the suite and has no case to show it.
        if (!inner && status(attr(c.attrs, "result")) === "fail") {
            emit(c, suite, out);
            failures++;
            continue;
        }
        failures += inner;
    }
    return failures;
}

export function parseNUnit(xml: string): TestResult[] {
    const out: TestResult[] = [];
    walk(parseXml(xml), undefined, out);
    return out;
}
