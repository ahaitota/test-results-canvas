// Dart/Flutter `test --reporter=json`: a JSONL event stream where a test is a
// testStart/error*/testDone triple keyed by test id.

import type { TestResult, TestStatus } from "../types.js";
import { jsonLines, rec, str, num, joinMessage } from "./json.js";

interface Pending {
    row: TestResult;
    startedAt?: number;
    errors: string[];
}

function status(result: string | undefined, skipped: unknown): TestStatus {
    if (skipped === true) return "skip";
    return result === "success" ? "pass" : "fail";
}

export function parseDart(text: string): TestResult[] {
    const suites = new Map<number, string>();
    const pending = new Map<number, Pending>();
    const out: TestResult[] = [];

    for (const event of jsonLines(text)) {
        const type = str(event, "type");
        if (type === "suite") {
            const suite = rec(event.suite);
            const id = num(suite, "id");
            const path = str(suite, "path");
            if (id != null && path) suites.set(id, path);
            continue;
        }
        if (type === "testStart") {
            const test = rec(event.test);
            const id = num(test, "id");
            const name = str(test, "name");
            if (id == null || !name) continue;
            const suiteId = num(test, "suiteID");
            const path = suiteId == null ? undefined : suites.get(suiteId);
            pending.set(id, {
                row: { name, status: "pass", suite: path, file: path, framework: "dart test" },
                startedAt: num(event, "time"),
                errors: [],
            });
            continue;
        }
        if (type === "error") {
            const entry = pending.get(num(event, "testID") ?? -1);
            if (entry) entry.errors.push(joinMessage(str(event, "error"), str(event, "stackTrace")) ?? "");
            continue;
        }
        if (type !== "testDone") continue;
        const entry = pending.get(num(event, "testID") ?? -1);
        // Hidden entries are the runner's own loading/compiling steps.
        if (!entry || event.hidden === true) continue;
        pending.delete(num(event, "testID") ?? -1);
        const done = num(event, "time");
        entry.row.status = status(str(event, "result"), event.skipped);
        entry.row.durationMs = done != null && entry.startedAt != null ? done - entry.startedAt : undefined;
        entry.row.message = joinMessage(...entry.errors);
        out.push(entry.row);
    }
    return out;
}
