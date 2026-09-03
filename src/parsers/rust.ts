// Rust libtest JSON (`cargo test -- -Z unstable-options --format json`) and
// `cargo nextest run --message-format libtest-json`: one event per line.

import type { TestResult, TestStatus } from "../types.js";
import { jsonLines, str, num } from "./json.js";

function status(event: string): TestStatus | null {
    if (event === "ok") return "pass";
    if (event === "failed" || event === "timeout") return "fail";
    if (event === "ignored") return "skip";
    return null; // "started"
}

export function parseRustJson(text: string): TestResult[] {
    const out: TestResult[] = [];
    for (const event of jsonLines(text)) {
        if (str(event, "type") !== "test") continue;
        const name = str(event, "name");
        const outcome = status(str(event, "event") ?? "");
        if (!name || !outcome) continue;
        const secs = num(event, "exec_time");
        const path = name.split("::");
        out.push({
            name,
            status: outcome,
            durationMs: secs == null ? undefined : Math.round(secs * 1000),
            message: outcome === "pass" ? undefined : (str(event, "stdout") ?? str(event, "message")),
            className: path.length > 1 ? path.slice(0, -1).join("::") : undefined,
            method: path[path.length - 1],
            suite: path.length > 1 ? path[0] : undefined,
            framework: "libtest",
        });
    }
    return out;
}
