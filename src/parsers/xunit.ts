// xUnit.net v2/v3 result XML: <assemblies> / <assembly> / <collection> / <test>.

import type { TestResult, TestStatus } from "../types.js";
import { attr, parseXml, child, childText, findAll } from "../xml.js";
import type { XmlElement } from "../xml.js";
import { joinMessage } from "./json.js";

function status(result: string | undefined): TestStatus {
    const r = String(result || "").toLowerCase();
    if (r === "pass") return "pass";
    if (r === "fail") return "fail";
    return "skip";
}

function emit(el: XmlElement, assembly: XmlElement, collection: string | undefined, out: TestResult[]): void {
    const name = attr(el.attrs, "name");
    if (!name) return;
    const failure = child(el, "failure");
    const time = parseFloat(attr(el.attrs, "time") ?? "");
    const date = attr(assembly.attrs, "run-date");
    const clock = attr(assembly.attrs, "run-time");
    out.push({
        name,
        status: status(attr(el.attrs, "result")),
        durationMs: Number.isFinite(time) ? Math.round(time * 1000) : undefined,
        message: joinMessage(childText(failure, "message"), childText(failure, "stack-trace"), childText(el, "reason")),
        className: attr(el.attrs, "type"),
        method: attr(el.attrs, "method") ?? name,
        suite: collection,
        framework: "xUnit.net",
        storage: attr(assembly.attrs, "name"),
        startTime: date && clock ? `${date}T${clock}` : undefined,
    });
}

export function parseXunit(xml: string): TestResult[] {
    const out: TestResult[] = [];
    for (const assembly of findAll(parseXml(xml), "assembly")) {
        for (const collection of assembly.children) {
            if (collection.name !== "collection") continue;
            for (const test of findAll(collection, "test")) emit(test, assembly, attr(collection.attrs, "name"), out);
        }
    }
    return out;
}
