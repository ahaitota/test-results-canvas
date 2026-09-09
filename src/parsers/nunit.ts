// NUnit 3 result XML: <test-run> / nested <test-suite> / <test-case>.

import type { TestResult, TestStatus } from "../types.js";
import { attr, parseXml, child, childText } from "../xml.js";
import type { XmlElement } from "../xml.js";
import { joinMessage } from "./json.js";

// The outcomes NUnit writes, across versions 2 and 3. Anything else is not a
// result this report can be read without: defaulting it to "skip" would take a
// failure off the run.
const STATUS = new Map<string, TestStatus>([
    ["passed", "pass"], ["success", "pass"], ["warning", "pass"],
    ["failed", "fail"], ["failure", "fail"], ["error", "fail"],
    ["skipped", "skip"], ["ignored", "skip"], ["inconclusive", "skip"], ["notrunnable", "skip"],
]);

function status(result: string | undefined): TestStatus | undefined {
    return STATUS.get(String(result || "").toLowerCase());
}

function seconds(value: string | undefined): number | undefined {
    const n = parseFloat(value ?? "");
    return Number.isFinite(n) ? Math.round(n * 1000) : undefined;
}

// One <test-case>, which must be readable in full: a case with no name or an
// outcome this does not know is one the run cannot account for, and dropping it
// would leave a shorter, greener report behind.
function emitCase(el: XmlElement, suite: string | undefined, out: TestResult[]): void {
    const name = attr(el.attrs, "name");
    const outcome = status(attr(el.attrs, "result"));
    if (!name || !outcome) {
        throw new SyntaxError("nunit test-case is missing its name or a known result");
    }
    const failure = child(el, "failure");
    emitRow(el, name, failure ? "fail" : outcome, suite, out);
}

// A suite reports itself under whatever outcome it carries.
function emitSuite(el: XmlElement, suite: string | undefined, out: TestResult[]): void {
    const name = attr(el.attrs, "name");
    if (name) emitRow(el, name, "fail", suite, out);
}

function emitRow(el: XmlElement, name: string, status: TestStatus, suite: string | undefined, out: TestResult[]): void {
    const failure = child(el, "failure");
    const detail = failure ?? child(el, "reason");
    // A warning records itself as an assertion rather than a reason, and that
    // text is the only account of what it warned about.
    const assertion = child(child(el, "assertions"), "assertion");
    out.push({
        name,
        status,
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
            emitCase(c, suite, out);
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
            emitSuite(c, suite, out);
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
    // NUnit 3 counts its own <test-case> elements, one counter per raw result.
    // Tallied from the cases rather than from the rows, because the rows also
    // carry suite-level failures NUnit counts nowhere.
    const run = root.name === "test-run" ? root : child(root, "test-run");
    if (run) {
        const cases = new Map<string, number>();
        countCases(run, cases);
        for (const name of ["passed", "failed", "skipped", "inconclusive", "warnings"]) {
            const declared = Number(attr(run.attrs, name));
            // `warnings` is spelled plural in the counter and singular in a
            // result, and the rest match their result word exactly.
            const found = cases.get(name === "warnings" ? "warning" : name) ?? 0;
            if (Number.isFinite(declared) && declared !== found) {
                throw new SyntaxError(`nunit run declared ${declared} ${name}, found ${found}`);
            }
        }
    }
    // Nothing beneath owned the failure, which a report can manage when the run
    // failed before any suite did. Better one row saying so than an empty run
    // that reads as green.
    if (!out.length) {
        const failedRun = run ?? child(root, "test-results");
        if (failedRun && status(attr(failedRun.attrs, "result")) === "fail") {
            const failure = child(failedRun, "failure");
            out.push({
                name: attr(failedRun.attrs, "name") ?? "test run",
                status: "fail",
                message: joinMessage(childText(failure, "message"), childText(failure, "stack-trace")),
                framework: "NUnit",
            });
        }
    }
    return out;
}

// Every <test-case> under `el`, tallied by the raw result NUnit wrote.
function countCases(el: XmlElement, into: Map<string, number>): void {
    for (const child of el.children) {
        if (child.name === "test-case") {
            const result = String(attr(child.attrs, "result") ?? "").toLowerCase();
            into.set(result, (into.get(result) ?? 0) + 1);
        }
        countCases(child, into);
    }
}
