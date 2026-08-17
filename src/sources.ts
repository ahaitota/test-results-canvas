// Merging several results files into one run.
//
// A repo like AITestAgent doesn't produce one TRX — it produces one per test
// project. So the canvas' unit of "a run" is a SET of files, and this is the
// pure half of that: parsed rows in, one tagged list out.

import type { TestResult } from "./types.js";

// One file in the active set. `count` is what that file contributed, so callers
// can report a per-file receipt rather than only a total.
export interface Source {
    label: string;
    path: string;
    count: number;
}

export interface MergeInput {
    source: Source;
    results: readonly TestResult[];
}

// Concatenate every source's rows, tagging each with the file it came from.
// Sources keep the order given and rows keep file order within a source, so the
// merged list is identical every time it is rebuilt.
export function mergeSources(inputs: readonly MergeInput[]): TestResult[] {
    const merged: TestResult[] = [];
    for (const input of inputs) {
        for (const t of input.results) merged.push({ ...t, source: input.source.label });
    }
    return merged;
}
