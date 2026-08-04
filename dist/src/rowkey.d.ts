import type { TestResult } from "./types.js";
export declare function rowIdentity(t: TestResult): string;
export declare function occurrenceSig(t: TestResult): string;
export interface Reconciled {
    keys: string[];
    reused: Set<string>;
}
export declare function reconcileRowKeys(next: readonly TestResult[], prev: readonly TestResult[], prevKeys: readonly string[], seq: Map<string, number>): Reconciled;
export declare function pruneKeys(set: Set<string>, reused: Set<string>): Set<string>;
