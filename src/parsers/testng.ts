// TestNG result XML: <testng-results> / <suite> / <test> / <class> / <test-method>.

import type { TestResult, TestStatus } from "../types.js";
import { attr, parseXml, child, childText, findAll } from "../xml.js";
import { joinMessage } from "./json.js";

function status(raw: string | undefined): TestStatus {
    const s = String(raw || "").toUpperCase();
    if (s === "PASS") return "pass";
    if (s === "FAIL") return "fail";
    return "skip";
}

export function parseTestNG(xml: string): TestResult[] {
    const out: TestResult[] = [];
    for (const suite of findAll(parseXml(xml), "suite")) {
        const suiteName = attr(suite.attrs, "name");
        for (const cls of findAll(suite, "class")) {
            const className = attr(cls.attrs, "name");
            for (const method of findAll(cls, "test-method")) {
                const name = attr(method.attrs, "name");
                if (!name) continue;
                const outcome = status(attr(method.attrs, "status"));
                // @BeforeMethod/@AfterMethod and the like are setup, not tests --
                // until one fails, when it IS the run's failure and the tests it
                // guarded are only reported as skipped.
                if (attr(method.attrs, "is-config") === "true" && outcome === "pass") continue;
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
    return out;
}
