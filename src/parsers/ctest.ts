// CTest XML (Testing/*/Test.xml): <Site> / <Testing> / <Test Status="...">.

import type { TestResult, TestStatus } from "../types.js";
import { attr, parseXml, child, childText, findAll } from "../xml.js";
import type { XmlElement } from "../xml.js";
import { joinMessage } from "./json.js";

function status(raw: string | undefined): TestStatus {
    const s = String(raw || "").toLowerCase();
    if (s === "passed") return "pass";
    if (s === "failed") return "fail";
    return "skip";
}

// CTest reports numbers as <NamedMeasurement name="..."><Value>.
function measurement(results: XmlElement | undefined, name: string): string | undefined {
    for (const m of results?.children ?? []) {
        if (m.name === "NamedMeasurement" && attr(m.attrs, "name") === name) return childText(m, "Value");
    }
    return undefined;
}

export function parseCTest(xml: string): TestResult[] {
    const out: TestResult[] = [];
    for (const testing of findAll(parseXml(xml), "Testing")) {
        const startTime = childText(testing, "StartDateTime");
        for (const test of testing.children) {
            // <TestList> repeats every test as a bare <Test>name</Test>; only the
            // outcome elements carry a Status.
            const outcome = attr(test.attrs, "Status");
            if (test.name !== "Test" || !outcome) continue;
            const name = childText(test, "Name");
            if (!name) continue;
            const results = child(test, "Results");
            const seconds = Number(measurement(results, "Execution Time"));
            const failed = status(outcome) === "fail";
            out.push({
                name,
                status: status(outcome),
                durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined,
                message: failed ? joinMessage(measurement(results, "Exception"), childText(child(results, "Measurement"), "Value")) : undefined,
                suite: childText(test, "Path"),
                framework: "CTest",
                startTime,
            });
        }
    }
    return out;
}
