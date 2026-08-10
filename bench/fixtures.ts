// Synthetic result runs for the rendering benchmark.
//
// Generated from a fixed seed so a before/after comparison measures the
// renderer and not different data, and shaped like a real run: many suites,
// long class names, a mix of outcomes, and multi-line failure messages.
import type { TestResult, TestStatus } from "../src/types.js";

// xorshift32: seedable and stable across Node versions, unlike Math.random.
function makeRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

const AREAS = ["Api", "Db", "Auth", "Billing", "Search", "Sync", "Ui", "Reporting"];
const FEATURES = ["Smoke", "Repository", "Contract", "Regression", "Integration", "Unit", "Boundary"];
const VERBS = ["returns", "rejects", "retries", "caches", "validates", "serializes", "throws", "skips"];
const NOUNS = ["an empty payload", "a stale token", "a duplicate row", "the default tenant", "a partial page", "a null id", "a large batch", "unicode names"];

// Mostly green, with a visible band of failures and a few skips.
const FAIL_RATE = 0.08;
const SKIP_RATE = 0.04;

function stack(name: string, area: string, feature: string): string {
  return [
    `AssertionError: ${name} did not behave as expected`,
    "  Expected: True",
    "  Actual:   False",
    `   at ${area}.${feature}Tests.${name.replace(/\W+/g, "_")}() in /src/${area}/${feature}Tests.cs:line 42`,
    "   at System.RuntimeMethodHandle.InvokeMethod(Object target, Void** arguments)",
  ].join("\n");
}

export interface GenerateOptions {
  seed?: number;
  // Tests per suite; the suite count follows from `count`.
  suiteSize?: number;
}

// A deterministic run of `count` results.
export function generateResults(count: number, options: GenerateOptions = {}): TestResult[] {
  const { seed = 1337, suiteSize = 40 } = options;
  const rand = makeRandom(seed);
  const results: TestResult[] = [];
  const start = Date.UTC(2026, 6, 27, 13, 0, 0);

  for (let i = 0; i < count; i++) {
    const suiteIndex = Math.floor(i / suiteSize);
    const area = AREAS[suiteIndex % AREAS.length];
    const feature = FEATURES[Math.floor(suiteIndex / AREAS.length) % FEATURES.length];
    const className = `Contoso.${area}.${feature}.${feature}Tests${suiteIndex}`;
    const suite = `${className}Suite`;
    const name = `${VERBS[i % VERBS.length]} ${NOUNS[(i >> 3) % NOUNS.length]} #${i}`;

    const roll = rand();
    const status: TestStatus = roll < FAIL_RATE ? "fail" : roll < FAIL_RATE + SKIP_RATE ? "skip" : "pass";
    // Long tail: most tests are quick, a few dominate the run.
    const durationMs = status === "skip" ? 0 : Math.round(rand() ** 4 * 12_000 + rand() * 40);
    const startedAt = new Date(start + i * 7).toISOString().replace(/\.\d+Z$/, "");

    results.push({
      name,
      status,
      durationMs,
      message: status === "fail" ? stack(name, area, feature) : status === "skip" ? "pending backend support" : undefined,
      className,
      method: name,
      suite,
      framework: i % 3 === 0 ? "net8.0" : "net9.0",
      computerName: `ci-agent-${(i % 4) + 1}`,
      startTime: startedAt,
    });
  }
  return results;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Serialize a run as JUnit XML: one <testsuite> per suite, in payload order.
export function toJUnitXml(results: readonly TestResult[]): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', "<testsuites>"];
  let i = 0;
  while (i < results.length) {
    const suite = results[i].suite || "";
    const timestamp = results[i].startTime || "";
    const hostname = results[i].computerName || "";
    const cases: string[] = [];
    while (i < results.length && (results[i].suite || "") === suite) {
      const t = results[i++];
      const head = `    <testcase name="${xmlEscape(t.name)}" classname="${xmlEscape(t.className || "")}" time="${((t.durationMs || 0) / 1000).toFixed(3)}"`;
      if (t.status === "fail") {
        cases.push(`${head}>\n      <failure message="assertion failed" type="AssertionError">${xmlEscape(t.message || "")}</failure>\n    </testcase>`);
      } else if (t.status === "skip") {
        cases.push(`${head}>\n      <skipped message="${xmlEscape(t.message || "")}" />\n    </testcase>`);
      } else {
        cases.push(`${head} />`);
      }
    }
    out.push(`  <testsuite name="${xmlEscape(suite)}" hostname="${xmlEscape(hostname)}" timestamp="${xmlEscape(timestamp)}">`);
    out.push(...cases);
    out.push("  </testsuite>");
  }
  out.push("</testsuites>", "");
  return out.join("\n");
}

// The scales the harness reports on; 50k is the "does it survive" case.
export const SCALES = [100, 1_000, 10_000, 50_000] as const;
