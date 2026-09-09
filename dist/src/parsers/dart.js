// Dart/Flutter `test --reporter=json`: a JSONL event stream where a test is a
// testStart/error*/testDone triple keyed by test id.
//
// The protocol allows an asynchronous `error` to arrive AFTER a test's
// testDone, with no second testDone behind it, so a test stays addressable by
// its id until the run's own `done` event and its rows are only finalised then.
import { jsonLines, rec, str, num, joinMessage } from "./json.js";
function status(result, skipped) {
    if (skipped === true)
        return "skip";
    return result === "success" ? "pass" : "fail";
}
export function parseDart(text) {
    const suites = new Map();
    const tests = new Map();
    // testDone order, which is the order the runner reported them in.
    const finished = [];
    let events = 0;
    let sawDone = false;
    let failedRun = false;
    for (const event of jsonLines(text)) {
        events++;
        const type = str(event, "type");
        if (type === "done") {
            sawDone = true;
            // `success` is how the runner reports the verdict; null means the
            // run was interrupted, which is not a run to present as finished.
            if (typeof event.success !== "boolean")
                throw new SyntaxError("dart run did not report whether it succeeded");
            failedRun = event.success === false;
            continue;
        }
        if (type === "suite") {
            const suite = rec(event.suite);
            const id = num(suite, "id");
            const path = str(suite, "path");
            if (id != null && path)
                suites.set(id, path);
            continue;
        }
        if (type === "testStart") {
            const test = rec(event.test);
            const id = num(test, "id");
            const name = str(test, "name");
            // An event this cannot read is a test the run cannot account for.
            if (id == null || !name)
                throw new SyntaxError("dart testStart is missing its id or name");
            const suiteId = num(test, "suiteID");
            const path = suiteId == null ? undefined : suites.get(suiteId);
            tests.set(id, {
                row: { name, status: "pass", suite: path, file: path, framework: "dart test" },
                startedAt: num(event, "time"),
                errors: [],
                done: false,
            });
            continue;
        }
        if (type === "error") {
            const entry = tests.get(num(event, "testID") ?? -1);
            if (entry)
                entry.errors.push(joinMessage(str(event, "error"), str(event, "stackTrace")) ?? "");
            continue;
        }
        if (type !== "testDone")
            continue;
        const id = num(event, "testID") ?? -1;
        const entry = tests.get(id);
        if (!entry)
            continue;
        entry.done = true;
        // Hidden entries are the runner's own loading/compiling steps.
        if (event.hidden === true) {
            tests.delete(id);
            continue;
        }
        const at = num(event, "time");
        entry.row.status = status(str(event, "result"), event.skipped);
        entry.row.durationMs = at != null && entry.startedAt != null ? at - entry.startedAt : undefined;
        finished.push(entry);
    }
    // A test that started and never finished means the report was read
    // mid-write; the tests that did finish are not the whole run.
    for (const entry of tests.values()) {
        if (!entry.done)
            throw new SyntaxError("dart test stream ends with a test still running");
    }
    // Dart closes a run with a "done" event, so a stream without one was read
    // between two tests however tidy the tests themselves look.
    if (events && !sawDone)
        throw new SyntaxError("dart test stream has no done event");
    const out = finished.map((entry) => {
        // An error reported after the test passed still failed it: it is the
        // whole reason the protocol allows a late one.
        if (entry.errors.length)
            entry.row.status = "fail";
        entry.row.message = joinMessage(...entry.errors);
        return entry.row;
    });
    // The runner says the run failed and no test admits to it -- a teardown or
    // an unhandled error outside any test. Reporting it beats a green run.
    if (failedRun && !out.some((r) => r.status === "fail")) {
        out.push({ name: "dart test run failed", status: "fail", message: "the runner reported the run as failed with no failing test", framework: "dart test" });
    }
    return out;
}
//# sourceMappingURL=dart.js.map