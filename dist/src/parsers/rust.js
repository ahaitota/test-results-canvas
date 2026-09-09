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
    let suitesStarted = 0;
    let suitesEnded = 0;
    let expected = 0;
    for (const event of jsonLines(text)) {
        const type = str(event, "type");
        if (type === "suite") {
            // One suite per test binary, each opened by a "started" event that
            // declares how many tests it will report.
            if (str(event, "event") === "started") {
                suitesStarted++;
                expected += num(event, "test_count") ?? 0;
            }
            else {
                suitesEnded++;
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
        throw new SyntaxError("libtest stream ends with a test still running"); // Each suite closes with its own terminal event, and says up front how many
    // tests to expect -- both of which a snapshot taken between tests fails.
    if (suitesStarted !== suitesEnded)
        throw new SyntaxError("libtest stream ends before the suite finished");
    if (suitesStarted && expected !== out.length)
        throw new SyntaxError(`libtest suite declared ${expected} tests, reported ${out.length}`);
    return out;
}
//# sourceMappingURL=rust.js.map