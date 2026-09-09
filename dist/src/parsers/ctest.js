// CTest XML (Testing/*/Test.xml): <Site> / <Testing> / <Test Status="...">.
import { attr, parseXml, child, childText, findAll } from "../xml.js";
import { joinMessage } from "./json.js";
// The outcomes CTest writes. Anything else is not a result this report can be
// read without: defaulting it to "skip" would take a failure off the run.
const STATUS = new Map([["passed", "pass"], ["failed", "fail"], ["notrun", "skip"], ["disabled", "skip"]]);
// CTest reports numbers as <NamedMeasurement name="..."><Value>.
function measurement(results, name) {
    for (const m of results?.children ?? []) {
        if (m.name === "NamedMeasurement" && attr(m.attrs, "name") === name)
            return childText(m, "Value");
    }
    return undefined;
}
export function parseCTest(xml) {
    const out = [];
    for (const testing of findAll(parseXml(xml), "Testing")) {
        const startTime = childText(testing, "StartDateTime");
        for (const test of testing.children) {
            // <TestList> repeats every test as a bare <Test>name</Test>; only the
            // outcome elements carry a Status.
            const outcome = attr(test.attrs, "Status");
            if (test.name !== "Test" || !outcome)
                continue;
            const name = childText(test, "Name");
            const status = STATUS.get(outcome.toLowerCase());
            if (!name || !status) {
                throw new SyntaxError("ctest result is missing its name or a known status");
            }
            const results = child(test, "Results");
            const seconds = Number(measurement(results, "Execution Time"));
            // CTest's reason for stopping. A test that ran to the end and then
            // returned non-zero says "Completed", which is no reason at all.
            const reason = measurement(results, "Completion Status");
            out.push({
                name,
                status,
                durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined,
                message: status === "fail" ? joinMessage(reason === "Completed" ? undefined : reason, childText(child(results, "Measurement"), "Value")) : undefined,
                suite: childText(test, "Path"),
                framework: "CTest",
                startTime,
            });
        }
    }
    return out;
}
//# sourceMappingURL=ctest.js.map