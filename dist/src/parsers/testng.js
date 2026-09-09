// TestNG result XML: <testng-results> / <suite> / <test> / <class> / <test-method>.
import { attr, parseXml, child, childText, findAll } from "../xml.js";
import { joinMessage } from "./json.js";
// The outcomes TestNG writes. Anything else is not a result this report can be
// read without: defaulting it to "skip" would take a failure off the run.
const STATUS = new Map([["PASS", "pass"], ["FAIL", "fail"], ["SKIP", "skip"]]);
export function parseTestNG(xml) {
    const out = [];
    for (const suite of findAll(parseXml(xml), "suite")) {
        const suiteName = attr(suite.attrs, "name");
        for (const cls of findAll(suite, "class")) {
            const className = attr(cls.attrs, "name");
            for (const method of findAll(cls, "test-method")) {
                const name = attr(method.attrs, "name");
                const outcome = STATUS.get(String(attr(method.attrs, "status") ?? "").toUpperCase());
                if (!name || !outcome) {
                    throw new SyntaxError("testng method is missing its name or a known status");
                }
                // @BeforeMethod/@AfterMethod and the like are setup, not tests --
                // until one FAILS, when it is the run's real failure and the
                // tests it guarded only report as skipped. TestNG also skips the
                // rest of a fixture's config after one fails, and those would
                // only inflate the counts.
                if (attr(method.attrs, "is-config") === "true" && outcome !== "fail")
                    continue;
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
//# sourceMappingURL=testng.js.map