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
// One of an assembly's counters. A counter that is there but is not a number is
// a report that cannot be checked against itself, which is not a report to
// present as a run.
function counter(assembly, name) {
    const raw = attr(assembly.attrs, name);
    if (raw === undefined)
        return undefined;
    const n = numAttr(assembly.attrs, name);
    if (n === undefined)
        throw new SyntaxError(`xunit assembly has a ${name} counter that is not a number`);
    return n;
}
// What an assembly says each outcome holds. Undefined when the report does not
// count itself at all. `skip` covers both counters: the schema separates
// skipped from not-run, but a row can only say it did not run.
function declaredOutcomes(assembly) {
    const names = ["passed", "failed", "skipped"];
    const parts = names.map((n) => counter(assembly, n));
    if (parts.every((n) => n === undefined))
        return undefined;
    // The schema writes them together, so a set with a hole in it is malformed
    // rather than a report that simply does not count itself.
    const missing = names.filter((_, i) => parts[i] === undefined);
    if (missing.length)
        throw new SyntaxError(`xunit assembly counts itself but has no ${missing.join("/")}`);
    const [passed, failed, skipped] = parts;
    // v3 spells it `not-run`; `notrun` is accepted as well so a writer using
    // the older spelling is not read as having lost those tests.
    const notRun = counter(assembly, "not-run") ?? counter(assembly, "notrun") ?? 0;
    return { pass: passed, fail: failed, skip: skipped + notRun };
}
export function parseXunit(xml) {
    const out = [];
    for (const assembly of findAll(parseXml(xml), "assembly")) {
        let errors = 0;
        // <errors> sits outside every collection: fixture and assembly cleanup
        // blow up there, and nothing else in the report records that failure.
        for (const error of child(assembly, "errors")?.children ?? []) {
            if (error.name !== "error")
                continue;
            errors++;
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
        // The assembly counts its errors too, and they are failures no test
        // carries -- so one it declares but does not record is a lost failure.
        const declaredErrors = counter(assembly, "errors");
        if (declaredErrors !== undefined && declaredErrors !== errors) {
            throw new SyntaxError(`xunit assembly declared ${declaredErrors} errors, found ${errors}`);
        }
        const found = { pass: 0, fail: 0, skip: 0 };
        for (const collection of assembly.children) {
            if (collection.name !== "collection")
                continue;
            for (const test of findAll(collection, "test")) {
                emit(test, assembly, attr(collection.attrs, "name"), out);
                found[out[out.length - 1].status]++;
            }
        }
        // The assembly counts itself, in total and per outcome. Both are
        // checked: a total on its own does not notice a failure that has
        // arrived as a pass, and outcomes on their own are not written by every
        // version.
        const tests = found.pass + found.fail + found.skip;
        const total = counter(assembly, "total");
        if (total !== undefined && total !== tests) {
            throw new SyntaxError(`xunit assembly declared ${total} tests, found ${tests}`);
        }
        const declared = declaredOutcomes(assembly);
        if (declared && ["pass", "fail", "skip"].some((s) => declared[s] !== found[s])) {
            throw new SyntaxError(`xunit assembly declared ${declared.pass}/${declared.fail}/${declared.skip} pass/fail/skip, found ${found.pass}/${found.fail}/${found.skip}`);
        }
    }
    return out;
}
//# sourceMappingURL=xunit.js.map