// Allure 2 result JSON. One `<uuid>-result.json` per test, so a run is the whole
// directory: expandAllure() collects the siblings and the registry concatenates
// them in name order, which keeps a re-read of any one of them deterministic.
//
// `<uuid>-container.json` files sit alongside them and hold the fixtures --
// setup and teardown -- that Allure records nowhere else. A teardown that blew
// up is a failure of the run no test result mentions, so containers are read
// too, and the ones that failed become rows.

import { readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import type { TestResult, TestStatus } from "../types.js";
import { rec, str, num, arr, joinMessage, isoFromEpoch } from "./json.js";

const RESULT_SUFFIX = "-result.json";
const CONTAINER_SUFFIX = "-container.json";

// The statuses Allure's model defines; anything else is not a result record.
export const ALLURE_STATUS = new Set(["passed", "failed", "broken", "skipped", "unknown"]);

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

// A container groups results and carries their fixtures. Recognized by holding
// one of those arrays rather than by lacking a status, so a *result* that is
// missing its status is still rejected instead of passing for a container.
function isContainer(t: ReturnType<typeof rec>): boolean {
    return Array.isArray(t?.befores) || Array.isArray(t?.afters) || Array.isArray(t?.children);
}

// The fixtures a container ran that did not pass. A successful setup is not a
// test and only inflates the run; a failed one is the reason everything under
// it did not happen.
function fixtures(t: ReturnType<typeof rec>, out: TestResult[]): void {
    const owner = str(t, "name");
    for (const key of ["befores", "afters"]) {
        for (const entry of arr(t, key)) {
            const fixture = rec(entry);
            const name = str(fixture, "name");
            const outcome = str(fixture, "status");
            // A fixture this cannot read is one the run cannot account for: the
            // broken teardown with no name is exactly the failure that would
            // otherwise vanish and leave the folder looking green.
            if (!fixture || !name || !outcome || !ALLURE_STATUS.has(outcome.toLowerCase())) {
                throw new SyntaxError("allure fixture is missing its name or a known status");
            }
            if (status(outcome) !== "fail") continue;
            const start = num(fixture, "start");
            const stop = num(fixture, "stop");
            const details = rec(fixture?.statusDetails);
            out.push({
                name,
                status: "fail",
                durationMs: start != null && stop != null ? stop - start : undefined,
                message: joinMessage(str(details, "message"), str(details, "trace")),
                suite: owner,
                framework: "Allure",
                startTime: isoFromEpoch(start),
                endTime: isoFromEpoch(stop),
            });
        }
    }
}

export function parseAllure(text: string): TestResult[] {
    const parsed: unknown = JSON.parse(text);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const out: TestResult[] = [];
    for (const entry of entries) {
        const t = rec(entry);
        if (isContainer(t)) {
            fixtures(t, out);
            continue;
        }
        const name = str(t, "name") ?? str(t, "fullName");
        const outcome = str(t, "status");
        // Every result file is required input: one that carries no identity,
        // name or recognized status is not a result this run can be read
        // without, so it fails rather than quietly contributing no row.
        if (!t || !str(t, "uuid") || !name || !outcome || !ALLURE_STATUS.has(outcome.toLowerCase())) {
            throw new SyntaxError("allure result is missing its uuid, name or status");
        }
        const label = labels(t);
        const start = num(t, "start");
        const stop = num(t, "stop");
        const details = rec(t?.statusDetails);
        out.push({
            name,
            status: status(outcome),
            durationMs: start != null && stop != null ? stop - start : undefined,
            message: joinMessage(str(details, "message"), str(details, "trace")),
            className: label.get("testClass"),
            suite: label.get("suite") ?? label.get("parentSuite"),
            framework: label.get("framework"),
            startTime: isoFromEpoch(start),
            endTime: isoFromEpoch(stop),
        });
    }
    return out;
}

// A file Allure groups by folder. It only does that for its own naming, so a
// report that happens to be Allure JSON under some other name is its own run --
// and must keep its own key, or it would shadow every other candidate in the
// folder while parsing only itself.
export function isAllureRunFile(abs: string): boolean {
    return basename(abs).endsWith(RESULT_SUFFIX);
}

// The files that belong to the same run as `abs`: the results name-sorted, then
// the containers, so the fixtures that failed come after the tests and the
// order is the same on every re-read.
export function expandAllure(abs: string): string[] {
    if (!isAllureRunFile(abs)) return [abs];
    // A folder that cannot be listed is a run that cannot be read. Falling back
    // to this one file would present a single result as the whole directory.
    const dir = dirname(abs);
    const names = readdirSync(dir);
    const of = (suffix: string) => names.filter((n) => n.endsWith(suffix)).sort().map((n) => join(dir, n));
    const results = of(RESULT_SUFFIX);
    return results.length ? [...results, ...of(CONTAINER_SUFFIX)] : [abs];
}
