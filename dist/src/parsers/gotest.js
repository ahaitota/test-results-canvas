// `go test -json` (and `gotestsum --jsonfile`): one JSON event per line, several
// per test, so events are folded into one row per package+test.
//
// Events carrying no `Test` belong to the package. Most are noise, but a build
// or TestMain failure is reported only that way -- with no test to attach it to,
// the package itself becomes the failing row.
import { jsonLines, str, num } from "./json.js";
// Append to the list at `key`, creating it the first time.
function collect(into, key, line) {
    const lines = into.get(key) ?? [];
    if (!into.has(key))
        into.set(key, lines);
    lines.push(line);
}
// Build events name the target, not the package: "example/calc [example/calc.test]"
// is where "example/calc" failed, and its diagnostics belong to that package.
function packageOf(raw) {
    return raw?.replace(/\s*\[[^\]]*]\s*$/, "") || undefined;
}
export function parseGoTest(text) {
    const rows = new Map();
    const output = new Map();
    const started = new Map();
    const packageOutput = new Map();
    const packageFailed = new Map();
    // Every package the stream mentions, and the ones it saw finish. `go test`
    // closes each package with a Test-less terminal event, so a package still
    // open is a snapshot taken between tests.
    const packages = new Set();
    const packagesDone = new Set();
    for (const event of jsonLines(text)) {
        const action = str(event, "Action");
        const pkg = packageOf(str(event, "Package") ?? str(event, "ImportPath"));
        const test = str(event, "Test");
        if (pkg)
            packages.add(pkg);
        if (!test) {
            if (!pkg)
                continue;
            // `build-output` carries the compiler diagnostics; `output` the
            // runner's own lines.
            if (action === "output" || action === "build-output")
                collect(packageOutput, pkg, str(event, "Output") ?? "");
            if (action === "pass" || action === "fail" || action === "skip" || action === "build-fail")
                packagesDone.add(pkg);
            if (action === "fail" || action === "build-fail") {
                packageFailed.set(pkg, { time: str(event, "Time"), elapsed: num(event, "Elapsed") });
            }
            continue;
        }
        // A package reports its own outcome last, so anything after that is a
        // second run appended to the same file. Which run each row belongs to
        // is then anyone's guess, and a half-written one could pass for whole.
        if (pkg && packagesDone.has(pkg)) {
            throw new SyntaxError(`go test stream continues after ${pkg} finished`);
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
        if (action !== "pass" && action !== "fail" && action !== "skip")
            continue;
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
        if (row.status === "pass")
            continue;
        row.message = (output.get(key) ?? []).join("").trim() || undefined;
    }
    // The packages a test already failed in, so the package rows below do not
    // rescan every result for each of them.
    const failedInPackage = new Set();
    for (const row of rows.values()) {
        if (row.status === "fail" && row.suite)
            failedInPackage.add(row.suite);
    }
    // A test that started and never reached a terminal event means the stream
    // stops mid-run. Returning the tests that did finish would show a green
    // subset of a run whose outcome is not known yet.
    for (const key of started.keys()) {
        if (!rows.has(key))
            throw new SyntaxError("go test stream ends with a test still running");
    }
    // Same for the packages themselves: a stream cut between two tests has every
    // test it mentions accounted for, and still is not the whole run.
    for (const pkg of packages) {
        if (!packagesDone.has(pkg))
            throw new SyntaxError(`go test stream ends before ${pkg} finished`);
    }
    // Only when no test in that package already carries the failure: a package
    // fails whenever one of its tests does, and a second row would double-count
    // an outcome the run already shows.
    for (const [pkg, at] of packageFailed) {
        if (failedInPackage.has(pkg))
            continue;
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
//# sourceMappingURL=gotest.js.map