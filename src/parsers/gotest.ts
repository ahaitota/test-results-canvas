// `go test -json` (and `gotestsum --jsonfile`): one JSON event per line, several
// per test, so events are folded into one row per package+test.

import type { TestResult } from "../types.js";
import { jsonLines, str, num } from "./json.js";

export function parseGoTest(text: string): TestResult[] {
    const rows = new Map<string, TestResult>();
    const output = new Map<string, string[]>();
    for (const event of jsonLines(text)) {
        const test = str(event, "Test");
        // Events without a Test are package-level totals, not results.
        if (!test) continue;
        const pkg = str(event, "Package");
        const key = `${pkg ?? ""}\u0000${test}`;
        const action = str(event, "Action");
        if (action === "output") {
            const line = str(event, "Output");
            if (!line) continue;
            const lines = output.get(key) ?? [];
            if (!output.has(key)) output.set(key, lines);
            lines.push(line);
            continue;
        }
        if (action !== "pass" && action !== "fail" && action !== "skip") continue;
        const elapsed = num(event, "Elapsed");
        rows.set(key, {
            name: test,
            status: action === "pass" ? "pass" : action === "fail" ? "fail" : "skip",
            durationMs: elapsed == null ? undefined : Math.round(elapsed * 1000),
            className: pkg,
            method: test,
            suite: pkg,
            framework: "go test",
            startTime: str(event, "Time"),
        });
    }
    for (const [key, row] of rows) {
        if (row.status === "pass") continue;
        row.message = (output.get(key) ?? []).join("").trim() || undefined;
    }
    return [...rows.values()];
}
