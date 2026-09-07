// xUnit.net v2/v3 result XML: <assemblies> / <assembly> / <collection> / <test>.
import { attr, parseXml, child, childText, findAll } from "../xml.js";
import { joinMessage } from "./json.js";
function status(result) {
    const r = String(result || "").toLowerCase();
    if (r === "pass")
        return "pass";
    if (r === "fail")
        return "fail";
    return "skip";
}
function emit(el, assembly, collection, out) {
    const name = attr(el.attrs, "name");
    if (!name)
        return;
    const failure = child(el, "failure");
    const time = parseFloat(attr(el.attrs, "time") ?? "");
    // v3 timestamps each test; v2 only dated the assembly, so that is the
    // fallback rather than the source.
    const date = attr(assembly.attrs, "run-date");
    const clock = attr(assembly.attrs, "run-time");
    const assemblyStart = date && clock ? `${date}T${clock}` : undefined;
    out.push({
        name,
        status: status(attr(el.attrs, "result")),
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
        for (const collection of assembly.children) {
            if (collection.name !== "collection")
                continue;
            for (const test of findAll(collection, "test"))
                emit(test, assembly, attr(collection.attrs, "name"), out);
        }
    }
    return out;
}
//# sourceMappingURL=xunit.js.map