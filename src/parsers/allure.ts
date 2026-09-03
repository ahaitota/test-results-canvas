// Allure 2 result JSON. One `<uuid>-result.json` per test, so a run is the whole
// directory: expandAllure() collects the siblings and the registry concatenates
// them in name order, which keeps a re-read of any one of them deterministic.

import { readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import type { TestResult, TestStatus } from "../types.js";
import { rec, str, num, arr, joinMessage } from "./json.js";

const SUFFIX = "-result.json";

function status(raw: string | undefined): TestStatus {
    const s = String(raw || "").toLowerCase();
    if (s === "passed") return "pass";
    if (s === "failed" || s === "broken") return "fail";
    return "skip";
}

// Allure carries suite/framework/class as free-form { name, value } labels.
function labels(from: ReturnType<typeof rec>): Map<string, string> {
    const map = new Map<string, string>();
    for (const entry of arr(from, "labels")) {
        const l = rec(entry);
        const name = str(l, "name");
        const value = str(l, "value");
        if (name && value && !map.has(name)) map.set(name, value);
    }
    return map;
}

export function parseAllure(text: string): TestResult[] {
    const parsed: unknown = JSON.parse(text);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const out: TestResult[] = [];
    for (const entry of entries) {
        const t = rec(entry);
        const name = str(t, "name") ?? str(t, "fullName");
        if (!name) continue;
        const label = labels(t);
        const start = num(t, "start");
        const stop = num(t, "stop");
        const details = rec(t?.statusDetails);
        out.push({
            name,
            status: status(str(t, "status")),
            durationMs: start != null && stop != null ? stop - start : undefined,
            message: joinMessage(str(details, "message"), str(details, "trace")),
            className: label.get("testClass"),
            suite: label.get("suite") ?? label.get("parentSuite"),
            framework: label.get("framework"),
            startTime: start == null ? undefined : new Date(start).toISOString(),
            endTime: stop == null ? undefined : new Date(stop).toISOString(),
        });
    }
    return out;
}

// The result files that belong to the same run as `abs`, name-sorted.
export function expandAllure(abs: string): string[] {
    if (!basename(abs).endsWith(SUFFIX)) return [abs];
    try {
        const dir = dirname(abs);
        const names = readdirSync(dir).filter((n) => n.endsWith(SUFFIX)).sort();
        return names.length ? names.map((n) => join(dir, n)) : [abs];
    } catch {
        return [abs];
    }
}
