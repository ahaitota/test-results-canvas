// xUnit.net v2/v3 result XML: <assemblies> / <assembly> / <collection> / <test>.
import { attr, numAttr, parseXml, child, childText, findAll } from "../xml.js";
import { joinMessage } from "./json.js";
// The outcomes the xUnit schema defines. A record outside them is not one this
// report can be read without, so it is rejected rather than defaulted -- the
// default was "skip", which quietly turned a failure into a test nobody ran.
const RESULTS = new Map([["pass", "pass"], ["fail", "fail"], ["skip", "skip"], ["notrun", "skip"]]);
function emit(el, assembly, collection, out) {
    const name = attr(el.attrs, "name");
    const outcome = attr(el.attrs, "result");
    const status = RESULTS.get(String(outcome ?? "").toLowerCase());
    if (!name || !status) {
        throw new SyntaxError("xunit test is missing its name or a known result");
    }
    const failure = child(el, "failure");
    const time = parseFloat(attr(el.attrs, "time") ?? "");
    // v3 timestamps each test; v2 only dated the assembly, so that is the
    // fallback rather than the source.
    const date = attr(assembly.attrs, "run-date");
    const clock = attr(assembly.attrs, "run-time");
    const assemblyStart = date && clock ? `${date}T${clock}` : undefined;
    out.push({
        name,
        // A record carrying a failure failed, whatever it says of itself.
        status: failure ? "fail" : status,
        durationMs: Number.isFinite(time) ? Math.round(time * 1000) : undefined,
        message: joinMessage(childText(failure, "message"), childText(failure, "stack-trace"), childText(el, "reason")),
        className: attr(el.attrs, "type"),
        method: attr(el.attrs, "method") ?? name,
        suite: collection,
        // The one field that links a test to a path without guessing, which is
        // what diff mode wants first.
        file: attr(el.attrs, "source-file"),
        framework: "xUnit.net",
        storage: attr(assembly.attrs, "name"),
        startTime: attr(el.attrs, "start-rtf") ?? assemblyStart,
        endTime: attr(el.attrs, "finish-rtf"),
    });
}
// What an assembly says it holds, from the breakdown rather than `total`: the
// parts are unambiguous, where `total` has meant different things across
// versions. Undefined when the report does not count itself.
function declaredTests(assembly) {
    const parts = ["passed", "failed", "skipped"].map((n) => numAttr(assembly.attrs, n));
    if (parts.some((n) => n === undefined))
        return undefined;
    // v3 spells it `not-run`; `notrun` is accepted as well so a writer using
    // the older spelling is not read as having lost those tests.
    const notRun = numAttr(assembly.attrs, "not-run") ?? numAttr(assembly.attrs, "notrun") ?? 0;
    return parts.reduce((sum, n) => sum + n, 0) + notRun;
}
export function parseXunit(xml) {
    const out = [];
    for (const assembly of findAll(parseXml(xml), "assembly")) {
        // <errors> sits outside every collection: fixture and assembly cleanup
        // blow up there, and nothing else in the report records that failure.
        for (const error of child(assembly, "errors")?.children ?? []) {
            if (error.name !== "error")
                continue;
            const failure = child(error, "failure");
            out.push({
                name: attr(error.attrs, "name") ?? attr(error.attrs, "type") ?? "assembly error",
                status: "fail",
                message: joinMessage(attr(failure?.attrs, "exception-type"), childText(failure, "message"), childText(failure, "stack-trace")),
                suite: attr(error.attrs, "type"),
                framework: "xUnit.net",
                storage: attr(assembly.attrs, "name"),
            });
        }
        let tests = 0;
        for (const collection of assembly.children) {
            if (collection.name !== "collection")
                continue;
            for (const test of findAll(collection, "test")) {
                emit(test, assembly, attr(collection.attrs, "name"), out);
                tests++;
            }
        }
        // The assembly counts itself, so a mismatch means rows went missing
        // between the runner writing those counters and this file being read.
        const declared = declaredTests(assembly);
        if (declared !== undefined && declared !== tests) {
            throw new SyntaxError(`xunit assembly declared ${declared} tests, found ${tests}`);
        }
    }
    return out;
}
//# sourceMappingURL=xunit.js.map