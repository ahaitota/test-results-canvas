// Builds the message the canvas sends back into the agent session when the user
// asks about a test. Pure and host-free so it can be unit-tested without the app
// or a live session -- the SDK is never imported here.
import type { TestResult } from "./types.js";

// Failure output can be a full stack trace. Cap it so the injected message stays
// readable in the conversation; the agent can always open the file for the rest.
const MAX_MESSAGE_CHARS = 1500;

// A test's display path, e.g. "billing > rejects negative amount".
export function testPath(t: TestResult): string {
  const scope = t.suite || t.className;
  return scope ? `${scope} > ${t.name}` : t.name;
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

// The test name and failure output come from a results file, so they are data,
// not instructions. Quoting the name and fencing the message keeps that boundary
// visible; it reduces rather than removes the risk of a hostile report steering
// the agent.
export function composeAskPrompt(t: TestResult): string {
  const verb = t.status === "fail" ? "failure" : `${t.status === "skip" ? "skipped" : "passing"} test`;
  const parts = [`Investigate the "${testPath(t)}" test ${verb}.`];

  const facts: string[] = [];
  if (t.className) facts.push(`- Class: ${t.className}`);
  if (t.method) facts.push(`- Method: ${t.method}`);
  if (t.framework) facts.push(`- Framework: ${t.framework}`);
  if (t.durationMs != null) facts.push(`- Duration: ${t.durationMs}ms`);
  if (facts.length) parts.push(facts.join("\n"));

  if (t.message && t.message.trim()) parts.push(`Reported output:\n${fenced(clip(t.message))}`);

  return parts.join("\n\n");
}
