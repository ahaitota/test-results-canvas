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
function label(s) {
    const flat = s
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .replace(/"/g, "'")
        .replace(/\s+/g, " ")
        .trim();
    return flat.length <= MAX_LABEL_CHARS ? flat : `${flat.slice(0, MAX_LABEL_CHARS)}...`;
}
// A test's display path, e.g. "billing > rejects negative amount".
export function testPath(t) {
    const scope = label(t.suite || t.className || "");
    const name = label(t.name) || "(unnamed)";
    return scope ? `${scope} > ${name}` : name;
}
// Wrap in a fence longer than any backtick run inside, so a message containing
// ``` cannot break out of the block and read as instructions.
function fenced(body) {
    let longest = 0;
    for (const run of body.match(/`+/g) || [])
        longest = Math.max(longest, run.length);
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `${fence}\n${body}\n${fence}`;
}
function clip(s) {
    const trimmed = s.trim();
    return trimmed.length <= MAX_MESSAGE_CHARS
        ? trimmed
        : trimmed.slice(0, MAX_MESSAGE_CHARS) + `\n... [truncated, ${trimmed.length - MAX_MESSAGE_CHARS} more characters]`;
}
// Every field here comes from a results file, so all of it is data, not
// instructions. Labels are flattened and capped, the message is fenced and
// capped; that keeps the boundary visible but reduces rather than removes the
// risk of a hostile report steering the agent.
export function composeAskPrompt(t) {
    const verb = t.status === "fail" ? "failure" : `${t.status === "skip" ? "skipped" : "passing"} test`;
    const parts = [`Investigate the "${testPath(t)}" test ${verb}.`];
    const facts = [];
    if (t.className)
        facts.push(`- Class: ${label(t.className)}`);
    if (t.method)
        facts.push(`- Method: ${label(t.method)}`);
    if (t.framework)
        facts.push(`- Framework: ${label(t.framework)}`);
    // Which results file the row came from. On a merged run that is the only thing
    // telling the agent which project failed.
    if (t.source)
        facts.push(`- Source: ${label(t.source)}`);
    if (t.durationMs != null)
        facts.push(`- Duration: ${t.durationMs}ms`);
    if (facts.length)
        parts.push(facts.join("\n"));
    if (t.message && t.message.trim())
        parts.push(`Reported output:\n${fenced(clip(t.message))}`);
    return parts.join("\n\n");
}
// --- Coverage prompts ---
//
// Same rules as above: every value comes out of a coverage report, so it is
// data, not instructions. Paths are flattened and capped like test labels, and
// line numbers are rendered from parsed integers rather than report text.
// Ranges kept short so the message stays readable in the conversation.
const MAX_RANGES = 12;
function rangeList(lines) {
    const ranges = toRanges(lines);
    const shown = ranges.slice(0, MAX_RANGES)
        .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`))
        .join(", ");
    return ranges.length > MAX_RANGES ? `${shown}, and ${ranges.length - MAX_RANGES} more` : shown;
}
// "Write tests for this file's uncovered lines."
export function composeCoveragePrompt(file) {
    const path = label(file.path) || "(unknown file)";
    const parts = [`Add tests that cover the untested code in "${path}".`];
    const facts = [];
    if (file.percent != null)
        facts.push(`- Current line coverage: ${file.percent}%`);
    if (file.uncoveredLines.length) {
        facts.push(`- Uncovered lines: ${rangeList(file.uncoveredLines)}`);
    }
    if (facts.length)
        parts.push(facts.join("\n"));
    parts.push("Read those lines first, then add tests to the project's existing test suite that exercise them. " +
        "Re-run the tests with coverage afterwards so this panel updates.");
    return parts.join("\n\n");
}
// "The code that just changed isn't covered -- write tests for it."
export function composePatchCoveragePrompt(patch) {
    const unknown = patch.unknownLines ?? 0;
    // A file the report never mentions is a gap, and so is one whose changed
    // lines it has no entry for -- invisible in the percentage either way.
    const gaps = patch.files.filter((f) => f.unmeasured || f.uncoveredLines.length > 0 || (f.unknownLines ?? 0) > 0);
    const lines = gaps.slice(0, MAX_RANGES).map((f) => {
        const path = label(f.path) || "(unknown file)";
        if (f.unmeasured)
            return `- ${path}: changed, but the report holds no data for it`;
        if (!f.uncoveredLines.length)
            return `- ${path}: ${f.unknownLines} changed line${f.unknownLines === 1 ? "" : "s"} the report does not mention`;
        return `- ${path}: uncovered lines ${rangeList(f.uncoveredLines)}`;
    });
    if (gaps.length > MAX_RANGES)
        lines.push(`- and ${gaps.length - MAX_RANGES} more files`);
    // The report measured none of the changed lines: it predates the edits or was
    // configured to skip these files, so the ask is a fresh run rather than tests
    // written against silence. Unmeasured is not the same as untested.
    if (patch.total === 0) {
        const detail = unknown > 0
            ? `all ${unknown} changed line${unknown === 1 ? " is" : "s are"} absent from it`
            : "it holds no data for the changed files";
        const parts = [
            `The coverage report says nothing about the changed code in the ${label(patch.against)}: ${detail}, `
                + "which is what a stale or partly configured report looks like. "
                + "Re-run the tests with coverage first and let this panel reload, then judge from the fresh report whether tests are missing.",
        ];
        if (lines.length)
            parts.push(lines.join("\n"));
        return parts.join("\n\n");
    }
    // Past the guard above, the report measured something, so it has a percentage.
    const headline = patch.covered === patch.total
        // Every line the report measured is covered, so the gap is what it did
        // not measure. "Only 100% is covered" would be a contradiction.
        ? `The coverage report accounts for only part of the changed code in the ${label(patch.against)}.`
        : `Only ${patch.percent}% of the changed code in the ${label(patch.against)} is covered by tests (${patch.covered} of ${patch.total} lines).`;
    const parts = [`${headline} Add tests for the untested changes.`];
    // Said before the file list, because it changes how the percentage above
    // should be read rather than adding to it.
    if (unknown > 0) {
        parts.push(`${unknown} changed line${unknown === 1 ? " is" : "s are"} absent from the report altogether, so that figure covers only the `
            + `${patch.total} it does measure. Some will be blank lines or braces; the rest mean the report predates these edits, so re-run the `
            + "tests with coverage before trusting it.");
    }
    const blind = patch.unmeasuredFiles;
    if (blind > 0) {
        const one = blind === 1;
        parts.push(`${blind} changed file${one ? " has" : "s have"} no entry in the report, so ${one ? "it was" : "they were"} not measured `
            + `rather than shown to be untested. Re-run the tests with coverage before writing tests for ${one ? "it" : "them"}.`);
    }
    if (lines.length)
        parts.push(lines.join("\n"));
    parts.push("Re-run the tests with coverage afterwards so this panel updates.");
    return parts.join("\n\n");
}
// "This run produced no coverage at all -- re-run collecting it."
export function composeEnableCoveragePrompt(command, ecosystem) {
    return [
        `Re-run this project's tests with code coverage collection enabled, then open the "Test Results" canvas with the coverage report so I can see what is covered.`,
        `Detected toolchain: ${label(ecosystem)}. Suggested command:\n${fenced(label(command))}`,
        "If that command is not right for this project, use the equivalent that produces a Cobertura, LCOV or JaCoCo report.",
    ].join("\n\n");
}
// --- Diff mode ---
//
// "Which tests does this change affect?" The canvas can only pair names; the
// agent can read the diff, so this hands it the question and asks for the
// answer back as canvas tags rather than prose.
// Enough to characterise the change without turning the message into a diff.
const MAX_LISTED_FILES = 30;
export function composeImpactPrompt(req) {
    const shown = req.files.slice(0, MAX_LISTED_FILES).map((f) => `- ${label(f)}`);
    const rest = req.changedFiles - shown.length;
    if (rest > 0)
        shown.push(`- and ${rest} more file${rest === 1 ? "" : "s"}`);
    return [
        `Work out which of this project's tests are affected by the ${label(req.against)}, then tag them in the Test Results canvas.`,
        `Changed files:\n${shown.join("\n")}`,
        `Read the changed code, follow it into whatever calls it, and decide which of the ${req.totalTests} tests in the current run could plausibly change behaviour or start failing because of it. Include tests that cover the changed code indirectly; leave out tests the change cannot reach.`,
        `Report the answer by invoking the "set_impacted_tests" action on the "Test Results" canvas (canvasId "example-canvas"), passing each test as { "name", "className", "reason" } with the reason naming the changed code it depends on. Use the exact names from the run — call "get_results" first if you need them. Don't print the list as chat text instead; the panel is where it is useful.`,
    ].join("\n\n");
}
//# sourceMappingURL=ask.js.map