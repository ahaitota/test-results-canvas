// TestNG result XML: <testng-results> / <suite> / <test> / <class> / <test-method>.

import type { TestResult, TestStatus } from "../types.js";
import { attr, parseXml, child, childText, findAll } from "../xml.js";
import { joinMessage } from "./json.js";

// The outcomes TestNG writes. Anything else is not a result this report can be
// read without: defaulting it to "skip" would take a failure off the run.
const STATUS = new Map<string, TestStatus>([["PASS", "pass"], ["FAIL", "fail"], ["SKIP", "skip"]]);

export function parseTestNG(xml: string): TestResult[] {
    const out: TestResult[] = [];
    const root = parseXml(xml);
    // What TestNG's own counters count: the passed/failed/skipped TEST
    // collections. Configuration methods are held separately and never counted,
    // and a retried attempt is counted under `retried` instead of `skipped`.
    const counted: Record<TestStatus, number> = { pass: 0, fail: 0, skip: 0 };
    for (const suite of findAll(root, "suite")) {
        const suiteName = attr(suite.attrs, "name");
        for (const cls of findAll(suite, "class")) {
            const className = attr(cls.attrs, "name");
            for (const method of findAll(cls, "test-method")) {
                const name = attr(method.attrs, "name");
                const outcome = STATUS.get(String(attr(method.attrs, "status") ?? "").toUpperCase());
                if (!name || !outcome) {
                    throw new SyntaxError("testng method is missing its name or a known status");
                }
                const isConfig = attr(method.attrs, "is-config") === "true";
                if (!isConfig && attr(method.attrs, "retried") !== "true") counted[outcome]++;
                // @BeforeMethod/@AfterMethod and the like are setup, not tests --
                // until one FAILS, when it is the run's real failure and the
                // tests it guarded only report as skipped. TestNG also skips the
                // rest of a fixture's config after one fails, and those would
                // only inflate the counts.
                if (isConfig && outcome !== "fail") continue;
                const ms = Number(attr(method.attrs, "duration-ms"));
                const ex = child(method, "exception");
                out.push({
                    name,
                    status: outcome,
                    durationMs: Number.isFinite(ms) ? ms : undefined,
                    message: joinMessage(attr(ex?.attrs, "class"), childText(ex, "message"), childText(ex, "full-stacktrace")),
                    className,
                    method: name,
                    suite: suiteName,
                    framework: "TestNG",
                    startTime: attr(method.attrs, "started-at"),
                    endTime: attr(method.attrs, "finished-at"),
                });
            }
        }
    }
    // <testng-results> carries those same three counts. `ignored` is left out:
    // it counts methods TestNG excluded, which it never writes an element for.
    const results = root.name === "testng-results" ? root : child(root, "testng-results");
    for (const [name, status] of [["passed", "pass"], ["failed", "fail"], ["skipped", "skip"]] as const) {
        const declared = Number(attr(results?.attrs, name));
        if (Number.isFinite(declared) && declared !== counted[status]) {
            throw new SyntaxError(`testng declared ${declared} ${name}, found ${counted[status]}`);
        }
    }
    return out;
}
