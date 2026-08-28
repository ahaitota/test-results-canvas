// Which tests matter for the change in front of you -- issue #8's "diff mode".
//
// Three signals, strongest first:
//   new       absent from the previous run, or its file is new to git
//   modified  the test's own file is in the diff
//   impacted  a changed production file whose name maps to this test's class
//
// The third is a guess. No report format links a test to the code it exercises,
// so naming habits (Calc.cs <-> CalcTests) are the only cross-ecosystem link;
// the UI labels it as such. Anything sharper comes from the agent, which can
// read the diff.
//
// Pure: the caller reads git and hands the result in.

import type { TestResult } from "../types.js";
import { rowIdentity } from "../rowkey.js";
import { isTestPath, isProductionSource } from "../coverage/sources/classify.js";
import { normalizeSlashes } from "../coverage/sources/paths.js";
import type { DiffResult } from "../coverage/analysis/gitdiff.js";
import type { DiffPayload, RelevanceTags, TestRelevance } from "./payload.js";

// Below this a name carries no signal: "id" and "io" pair with half the repo.
const MIN_TOKEN = 3;

// Reasons land in a tooltip.
const MAX_REASON = 160;

// How many changed paths reach the browser; the count beside them is exact.
const MAX_LISTED_FILES = 50;

// The affixes an ecosystem adds when naming a test after its subject:
// CalcTests, calc.spec.ts, test_calc.py, calc_test.go.
const TEST_AFFIXES = ["test", "tests", "spec", "specs"];

// Fold to letters and digits, so CalcTests, calc_tests and Calc-Tests match.
function squash(s: string): string {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// "src/Calc.cs" -> "Calc"; "src/calc.test.ts" -> "calc.test" (squash folds the affix in).
function stemOf(path: string): string {
    const base = normalizeSlashes(path).split("/").pop() ?? "";
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(0, dot) : base;
}

function clamp(s: string): string {
    const flat = String(s || "").replace(/\s+/g, " ").trim();
    return flat.length <= MAX_REASON ? flat : `${flat.slice(0, MAX_REASON)}...`;
}

// The names a test for `subject` is likely to carry. The bare name covers
// describe("Calc"), where the suite takes the subject's name with no affix.
export function expectedTestNames(subject: string): string[] {
    const base = squash(subject);
    if (base.length < MIN_TOKEN) return [];
    const out = [base];
    for (const affix of TEST_AFFIXES) {
        out.push(base + affix);
        out.push(affix + base);
    }
    return out;
}

// The names a test answers to. A class arrives fully qualified and a suite is
// sometimes a path, so each field yields itself, its file stem and its segments.
export function testTokens(t: TestResult): string[] {
    const out = new Set<string>();
    const add = (raw: string) => {
        const s = squash(raw);
        if (s.length >= MIN_TOKEN) out.add(s);
    };
    for (const field of [t.className, t.suite, t.file]) {
        if (!field) continue;
        const text = String(field);
        add(text);
        add(stemOf(text));
        for (const segment of text.split(/[./\\:]+/)) add(segment);
    }
    return [...out];
}

// One changed file, reduced to what tagging needs.
interface ChangedFile {
    path: string;
    // Untracked or newly added: its tests are new rather than modified.
    isNew: boolean;
    isTest: boolean;
}

interface ChangeIndex {
    files: ChangedFile[];
    // Lowercased repo-relative path -> file, for reports that name their file.
    byPath: Map<string, ChangedFile>;
    // Squashed stem of a changed *test* file -> that file.
    byTestName: Map<string, ChangedFile>;
    // Every name a test for a changed *production* file might carry -> that file.
    byExpectedName: Map<string, ChangedFile>;
}

// Index the diff once, so tagging a 50,000-row run is a lookup per row.
function indexChanges(changes: DiffResult | null): ChangeIndex {
    const index: ChangeIndex = { files: [], byPath: new Map(), byTestName: new Map(), byExpectedName: new Map() };
    if (!changes) return index;
    // First writer wins: two changed files can claim one name, and a stable
    // answer beats an arbitrarily better one.
    const claim = (map: Map<string, ChangedFile>, key: string, file: ChangedFile) => {
        if (key && !map.has(key)) map.set(key, file);
    };
    for (const raw of changes.files) {
        const path = normalizeSlashes(raw.path);
        if (!path) continue;
        const file: ChangedFile = { path, isNew: raw.all, isTest: isTestPath(path) };
        index.files.push(file);
        claim(index.byPath, path.toLowerCase(), file);
        if (file.isTest) {
            claim(index.byTestName, squash(stemOf(path)), file);
            continue;
        }
        if (!isProductionSource(path)) continue;
        for (const name of expectedTestNames(stemOf(path))) claim(index.byExpectedName, name, file);
    }
    return index;
}

// A report spells paths from the runner's working directory, not the repo root,
// so "tests/test_calc.py" has to find "pkg/tests/test_calc.py".
function matchByPath(index: ChangeIndex, file: string): ChangedFile | null {
    const wanted = normalizeSlashes(file).replace(/^\.\//, "").toLowerCase();
    if (!wanted) return null;
    const direct = index.byPath.get(wanted);
    if (direct) return direct;
    for (const candidate of index.files) {
        const p = candidate.path.toLowerCase();
        if (p.endsWith(`/${wanted}`) || wanted.endsWith(`/${p}`)) return candidate;
    }
    return null;
}

// The changed file this test points at. A test file wins over a production one:
// "you edited this test" beats "you edited something it may cover".
function locate(t: TestResult, tokens: readonly string[], index: ChangeIndex): ChangedFile | null {
    if (t.file) {
        const direct = matchByPath(index, String(t.file));
        if (direct) return direct;
    }
    for (const token of tokens) {
        const hit = index.byTestName.get(token);
        if (hit) return hit;
    }
    for (const token of tokens) {
        const hit = index.byExpectedName.get(token);
        if (hit) return hit;
    }
    return null;
}

function tagFor(
    t: TestResult,
    index: ChangeIndex,
    baseline: ReadonlySet<string> | null,
    agentReason: string | undefined,
): TestRelevance | null {
    // History first: a test the previous run never saw is new whatever git says.
    if (baseline && !baseline.has(rowIdentity(t))) {
        return { kind: "new", reason: "not in the previous run" };
    }
    const hit = locate(t, testTokens(t), index);
    if (hit?.isTest) {
        return hit.isNew
            ? { kind: "new", reason: clamp(`${hit.path} is a new file`) }
            : { kind: "modified", reason: clamp(`${hit.path} changed`) };
    }
    if (hit) return { kind: "impacted", reason: clamp(`${hit.path} changed`) };
    // The agent fills gaps rather than overriding: the tags above are facts.
    if (agentReason) return { kind: "impacted", reason: clamp(agentReason), fromAgent: true };
    return null;
}

// The identities of a run, to compare the next one against.
export function identitiesOf(results: readonly TestResult[]): Set<string> {
    const out = new Set<string>();
    for (const t of results) out.add(rowIdentity(t));
    return out;
}

export interface RelevanceInput {
    results: readonly TestResult[];
    // Identities from the previous run of the same file; null before a second
    // run has been seen.
    baseline?: ReadonlySet<string> | null;
    // What git reported, from changedLines().
    changes?: DiffResult | null;
    // Row index -> the agent's reason, from the set_impacted_tests action.
    agent?: ReadonlyMap<number, string> | null;
}

// Tag every relevant row. Null when there is no signal at all, so the UI can
// stay silent rather than claim nothing is relevant.
export function computeRelevance(input: RelevanceInput): DiffPayload | null {
    const { results } = input;
    const baseline = input.baseline ?? null;
    const changes = input.changes ?? null;
    const agent = input.agent ?? null;
    if (!changes && !baseline && !agent?.size) return null;

    const index = indexChanges(changes);
    const tags: RelevanceTags = {};
    const counts = { new: 0, modified: 0, impacted: 0, relevant: 0 };
    for (let i = 0; i < results.length; i++) {
        const tag = tagFor(results[i], index, baseline, agent?.get(i));
        if (!tag) continue;
        tags[i] = tag;
        counts[tag.kind]++;
        counts.relevant++;
    }
    return {
        against: changes?.against || (baseline ? "the previous run" : ""),
        tags,
        counts,
        changedFiles: index.files.length,
        files: index.files.slice(0, MAX_LISTED_FILES).map((f) => f.path),
        hasBaseline: Boolean(baseline),
    };
}

// --- Agent-supplied impact ---

// What the set_impacted_tests action accepts per entry. Typed as unknown
// because it arrives from the model.
export interface AgentTestRef {
    name?: unknown;
    className?: unknown;
    reason?: unknown;
}

function nameKey(s: unknown): string {
    return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Resolve the tests the agent named to row indexes. By name -- bare,
// class-qualified, or the class alone -- since that is all get_results shows.
// Unmatched names are reported back so the agent knows it missed.
export function matchAgentTests(
    results: readonly TestResult[],
    refs: readonly AgentTestRef[],
): { tags: Map<number, string>; unmatched: string[] } {
    const byKey = new Map<string, number[]>();
    const put = (key: string, i: number) => {
        if (!key) return;
        const list = byKey.get(key);
        if (list) list.push(i);
        else byKey.set(key, [i]);
    };
    for (let i = 0; i < results.length; i++) {
        const t = results[i];
        put(nameKey(t.name), i);
        if (t.className) {
            put(nameKey(`${t.className}.${t.name}`), i);
            put(nameKey(t.className), i);
        }
        if (t.method) put(nameKey(t.method), i);
    }

    const tags = new Map<number, string>();
    const unmatched: string[] = [];
    for (const ref of refs) {
        const name = nameKey(ref.name);
        const className = nameKey(ref.className);
        const keys = [
            className && name ? `${className}.${name}` : "",
            name,
            className,
        ].filter(Boolean);
        const hit = keys.map((k) => byKey.get(k)).find((rows) => rows && rows.length);
        if (!hit) {
            if (name || className) unmatched.push(clamp(String(ref.name ?? ref.className)));
            continue;
        }
        const reason = typeof ref.reason === "string" && ref.reason.trim()
            ? clamp(ref.reason)
            : "the agent flagged this test as impacted";
        for (const i of hit) if (!tags.has(i)) tags.set(i, reason);
    }
    return { tags, unmatched };
}
