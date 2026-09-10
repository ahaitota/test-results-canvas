// Rust libtest JSON (`cargo test -- -Z unstable-options --format json`) and
// `cargo nextest run --message-format libtest-json`: one event per line.
import { jsonLines, str, num, joinMessage } from "./json.js";
function status(event) {
    if (event === "ok")
        return "pass";
    if (event === "failed")
        return "fail";
    if (event === "ignored")
        return "skip";
    // "started" opens a test; "timeout" only reports that one is taking a
    // while, and the outcome still follows. Treating it as a failure both
    // invented a row and left the real one to disagree with the suite's count.
    return null;
}
export function parseRustJson(text) {
    const out = [];
    const running = new Set();
    const found = { pass: 0, fail: 0, skip: 0 };
    const declared = { pass: 0, fail: 0, skip: 0 };
    let suitesStarted = 0;
    let suitesEnded = 0;
    let expected = 0;
    let counted = true;
    let failedSuite = false;
    for (const event of jsonLines(text)) {
        const type = str(event, "type");
        if (type === "suite") {
            // One suite per test binary, each opened by a "started" event that
            // declares how many tests it will report.
            if (str(event, "event") === "started") {
                suitesStarted++;
                expected += num(event, "test_count") ?? 0;
                continue;
            }
            // libtest closes a suite with its verdict and its own tally. A word
            // this does not know is not a verdict, so the run has no outcome.
            const verdict = str(event, "event") ?? "";
            if (verdict !== "ok" && verdict !== "failed") {
                throw new SyntaxError(`libtest suite ended with an unknown event "${verdict}"`);
            }
            suitesEnded++;
            if (verdict === "failed")
                failedSuite = true;
            const names = ["passed", "failed", "ignored"];
            const parts = names.map((n) => num(event, n));
            // Written together, so a set with a hole in it is malformed rather
            // than a writer that simply does not tally.
            if (parts.some((n) => n != null) && parts.some((n) => n == null)) {
                throw new SyntaxError("libtest suite ended with an incomplete tally");
            }
            if (parts.some((n) => n == null))
                counted = false;
            else {
                declared.pass += parts[0];
                declared.fail += parts[1];
                declared.skip += parts[2];
            }
            continue;
        }
        if (type !== "test")
            continue;
        const name = str(event, "name");
        if (!name)
            continue;
        const outcome = status(str(event, "event") ?? "");
        if (!outcome) {
            // Both "started" and "timeout" leave the test open.
            running.add(name);
            continue;
        }
        running.delete(name);
        found[outcome]++;
        const secs = num(event, "exec_time");
        const path = name.split("::");
        out.push({
            name,
            status: outcome,
            durationMs: secs == null ? undefined : Math.round(secs * 1000),
            message: outcome === "pass" ? undefined : joinMessage(str(event, "stdout"), str(event, "message"), str(event, "reason")),
            className: path.length > 1 ? path.slice(0, -1).join("::") : undefined,
            method: path[path.length - 1],
            suite: path.length > 1 ? path[0] : undefined,
            framework: "libtest",
        });
    }
    // A test that started and never reported an outcome means the stream stops
    // mid-run, so what it does hold is not the whole run.
    if (running.size)
        throw new SyntaxError("libtest stream ends with a test still running");
    // libtest always opens with a suite, so test events without one are a
    // capture that began after the run did.
    if (out.length && !suitesStarted)
        throw new SyntaxError("libtest stream has no suite to account for its tests");
    // Each suite closes with its own terminal event, and says up front how many
    // tests to expect -- both of which a snapshot taken between tests fails.
    if (suitesStarted !== suitesEnded)
        throw new SyntaxError("libtest stream ends before the suite finished");
    if (suitesStarted && expected !== out.length)
        throw new SyntaxError(`libtest suite declared ${expected} tests, reported ${out.length}`);
    // And it tallies them per outcome, so a failure replaced by a pass is
    // caught where a total that still adds up would not notice.
    if (suitesStarted && counted && ["pass", "fail", "skip"].some((s) => declared[s] !== found[s])) {
        throw new SyntaxError(`libtest suite declared ${declared.pass}/${declared.fail}/${declared.skip} pass/fail/ignored, reported ${found.pass}/${found.fail}/${found.skip}`);
    }
    // The suite says it failed and no test admits to it: something failed
    // outside the tests, and a green run would be the wrong thing to show.
    if (failedSuite && !out.some((r) => r.status === "fail")) {
        out.push({ name: "libtest suite failed", status: "fail", message: "the suite reported itself as failed with no failing test", framework: "libtest" });
    }
    return out;
}
//# sourceMappingURL=rust.js.map