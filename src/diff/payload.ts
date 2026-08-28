// The diff-mode wire contract. Separate from relevance.ts because that module
// reaches into git and node:fs, which the client bundle must not pull in.

export type RelevanceKind = "new" | "modified" | "impacted";

export interface TestRelevance {
    kind: RelevanceKind;
    // Why this row is relevant, e.g. "src/Calc.cs changed".
    reason: string;
    // The agent named this test, rather than the naming heuristics.
    fromAgent?: boolean;
}

// Sparse on purpose: a 50,000-test run has a handful of relevant rows, and one
// null each would put a 50,000-entry array on the wire every refresh. Keys are
// indexes into the results array of the same payload.
export type RelevanceTags = Record<number, TestRelevance>;

export interface RelevanceCounts {
    new: number;
    modified: number;
    impacted: number;
    // Rows carrying any tag: what "Relevant only" leaves on screen.
    relevant: number;
}

export interface DiffPayload {
    // What was compared, e.g. "uncommitted changes". Empty when the tags rest
    // on run history alone.
    against: string;
    tags: RelevanceTags;
    counts: RelevanceCounts;
    // Files git reported, before any test mapping. Non-zero with zero tags is
    // itself an answer: nothing in the suite points at what changed.
    changedFiles: number;
    // The first few of those paths, capped -- a branch diff can run to thousands.
    files: string[];
    // False until a second run has been seen; "new" then rests on git alone.
    hasBaseline: boolean;
}
