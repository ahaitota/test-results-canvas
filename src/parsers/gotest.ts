// `go test -json` (and `gotestsum --jsonfile`): one JSON event per line, several
// per test, so events are folded into one row per package+test.
//
// Events carrying no `Test` belong to the package. Most are noise, but a build
// or TestMain failure is reported only that way -- with no test to attach it to,
// the package itself becomes the failing row.

import type { TestResult } from "../types.js";
import { jsonLines, str, num } from "./json.js";

// Append to the list at `key`, creating it the first time.
function collect(into: Map<string, string[]>, key: string, line: string): void {
    const lines = into.get(key) ?? [];
    if (!into.has(key)) into.set(key, lines);
    lines.push(line);
}

export function parseGoTest(text: string): TestResult[] {
    const rows = new Map<string, TestResult>();
    const output = new Map<string, string[]>();
    const started = new Map<string, string>();
    const packageOutput = new Map<string, string[]>();
    const packageFailed = new Map<string, { time?: string; elapsed?: number }>();

    for (const event of jsonLines(text)) {
        const action = str(event, "Action");
        const pkg = str(event, "Package") ?? str(event, "ImportPath");
        const test = str(event, "Test");
        if (!test) {
            if (!pkg) continue;
            if (action === "output") collect(packageOutput, pkg, str(event, "Output") ?? "");
            if (action === "fail" || action === "build-fail") {
                packageFailed.set(pkg, { time: str(event, "Time"), elapsed: num(event, "Elapsed") });
            }
            continue;
        }
        const key = `${pkg ?? ""}\u0000${test}`;
        if (action === "run") {
            started.set(key, str(event, "Time") ?? "");
            continue;
        }
        if (action === "output") {
            collect(output, key, str(event, "Output") ?? "");
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
            // The terminal event says when the test ENDED; only the `run` event
            // says when it began.
            startTime: started.get(key) || undefined,
            endTime: str(event, "Time"),
        });
    }

    for (const [key, row] of rows) {
        if (row.status === "pass") continue;
        row.message = (output.get(key) ?? []).join("").trim() || undefined;
    }

    // Only when no test in that package already carries the failure: a package
    // fails whenever one of its tests does, and a second row would double-count
    // an outcome the run already shows.
    for (const [pkg, at] of packageFailed) {
        if ([...rows.values()].some((r) => r.suite === pkg && r.status === "fail")) continue;
        rows.set(`${pkg}\u0000`, {
            name: pkg,
            status: "fail",
            durationMs: at.elapsed == null ? undefined : Math.round(at.elapsed * 1000),
            message: (packageOutput.get(pkg) ?? []).join("").trim() || undefined,
            className: pkg,
            suite: pkg,
            framework: "go test",
            endTime: at.time,
        });
    }
    return [...rows.values()];
}
