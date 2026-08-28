import type { TestResult } from "./types.js";
export interface Source {
    label: string;
    path: string;
    count: number;
}
export interface MergeInput {
    source: Source;
    results: readonly TestResult[];
}
export declare function mergeSources(inputs: readonly MergeInput[]): TestResult[];
