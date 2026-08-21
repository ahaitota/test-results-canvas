// Builds the message the canvas sends back into the agent session when the user
// asks about a test. Pure and host-free so it can be unit-tested without the app
// or a live session -- the SDK is never imported here.
import type { TestResult } from "./types.js";
import type { PatchCoverage } from "./coverage/index.js";
import { toRanges } from "./coverage/index.js";

// Failure output can be a full stack trace. Cap it so the injected message stays
// readable in the conversation; the agent can always open the file for the rest.
const MAX_MESSAGE_CHARS = 1500;

// Names and classes are single-line labels by convention, but they arrive in the
// same untrusted file as everything else, so the convention is not a guarantee.
const MAX_LABEL_CHARS = 200;

// Flatten a label so it cannot escape the sentence that quotes it. A double quote
// would close that quoted span early, and a newline would let whatever follows
// start a fresh paragraph that reads to the agent as a new instruction.
function label(s: string): string {
  const flat = s
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= MAX_LABEL_CHARS ? flat : `${flat.slice(0, MAX_LABEL_CHARS)}...`;
}

// A test's display path, e.g. "billing > rejects negative amount".
export function testPath(t: TestResult): string {
  const scope = label(t.suite || t.className || "");
  const name = label(t.name) || "(unnamed)";
  return scope ? `${scope} > ${name}` : name;
}

// Wrap in a fence longer than any backtick run inside, so a message containing
// ``` cannot break out of the block and read as instructions.
function fenced(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) || []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${body}\n${fence}`;
}

function clip(s: string): string {
  const trimmed = s.trim();
  return trimmed.length <= MAX_MESSAGE_CHARS
    ? trimmed
    : trimmed.slice(0, MAX_MESSAGE_CHARS) + `\n... [truncated, ${trimmed.length - MAX_MESSAGE_CHARS} more characters]`;
}

// Every field here comes from a results file, so all of it is data, not
// instructions. Labels are flattened and capped, the message is fenced and
// capped; that keeps the boundary visible but reduces rather than removes the
// risk of a hostile report steering the agent.
export function composeAskPrompt(t: TestResult): string {
  const verb = t.status === "fail" ? "failure" : `${t.status === "skip" ? "skipped" : "passing"} test`;
  const parts = [`Investigate the "${testPath(t)}" test ${verb}.`];

  const facts: string[] = [];
  if (t.className) facts.push(`- Class: ${label(t.className)}`);
  if (t.method) facts.push(`- Method: ${label(t.method)}`);
  if (t.framework) facts.push(`- Framework: ${label(t.framework)}`);
  if (t.durationMs != null) facts.push(`- Duration: ${t.durationMs}ms`);
  if (facts.length) parts.push(facts.join("\n"));

  if (t.message && t.message.trim()) parts.push(`Reported output:\n${fenced(clip(t.message))}`);

  return parts.join("\n\n");
}

// --- Coverage prompts ---
//
// Same rules as above: every value here comes out of a coverage report, so it is
// data, not instructions. Paths are flattened and capped exactly like test
// labels, and line numbers are rendered from parsed integers rather than from
// report text.

// Ranges kept short so the message stays readable in the conversation; the agent
// can open the file for the rest.
const MAX_RANGES = 12;

function rangeList(lines: readonly number[]): string {
  const ranges = toRanges(lines);
  const shown = ranges.slice(0, MAX_RANGES)
    .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`))
    .join(", ");
  return ranges.length > MAX_RANGES ? `${shown}, and ${ranges.length - MAX_RANGES} more` : shown;
}

export interface UncoveredFile {
  path: string;
  uncoveredLines: readonly number[];
  percent: number | null;
}

// "Write tests for this file's uncovered lines."
export function composeCoveragePrompt(file: UncoveredFile): string {
  const path = label(file.path) || "(unknown file)";
  const parts = [`Add tests that cover the untested code in "${path}".`];

  const facts: string[] = [];
  if (file.percent != null) facts.push(`- Current line coverage: ${file.percent}%`);
  if (file.uncoveredLines.length) {
    facts.push(`- Uncovered lines: ${rangeList(file.uncoveredLines)}`);
  }
  if (facts.length) parts.push(facts.join("\n"));

  parts.push(
    "Read those lines first, then add tests to the project's existing test suite that exercise them. " +
    "Re-run the tests with coverage afterwards so this panel updates.",
  );
  return parts.join("\n\n");
}

// "The code that just changed isn't covered -- write tests for it."
export function composePatchCoveragePrompt(patch: PatchCoverage): string {
  const gaps = patch.files.filter((f) => f.unmeasured || f.uncoveredLines.length > 0);
  const headline = patch.percent == null
    ? `None of the changed code in the ${label(patch.against)} is covered by tests.`
    : `Only ${patch.percent}% of the changed code in the ${label(patch.against)} is covered by tests (${patch.covered} of ${patch.total} lines).`;

  const parts = [`${headline} Add tests for the untested changes.`];

  const lines = gaps.slice(0, MAX_RANGES).map((f) => {
    const path = label(f.path) || "(unknown file)";
    return f.unmeasured
      ? `- ${path}: changed, but no test touches this file at all`
      : `- ${path}: uncovered lines ${rangeList(f.uncoveredLines)}`;
  });
  if (gaps.length > MAX_RANGES) lines.push(`- and ${gaps.length - MAX_RANGES} more files`);
  if (lines.length) parts.push(lines.join("\n"));

  parts.push("Re-run the tests with coverage afterwards so this panel updates.");
  return parts.join("\n\n");
}

// "This run produced no coverage at all -- re-run collecting it."
export function composeEnableCoveragePrompt(command: string, ecosystem: string): string {
  return [
    `Re-run this project's tests with code coverage collection enabled, then open the "Test Results" canvas with the coverage report so I can see what is covered.`,
    `Detected toolchain: ${label(ecosystem)}. Suggested command:\n${fenced(label(command))}`,
    "If that command is not right for this project, use the equivalent that produces a Cobertura, LCOV or JaCoCo report.",
  ].join("\n\n");
}
