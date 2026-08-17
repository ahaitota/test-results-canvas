import type { TestResult } from "../types.js";
import type { DiffResult } from "../coverage/gitdiff.js";
import type { DiffPayload } from "./payload.js";
export declare function expectedTestNames(subject: string): string[];
export declare function testTokens(t: TestResult): string[];
export declare function identitiesOf(results: readonly TestResult[]): Set<string>;
export interface RelevanceInput {
    results: readonly TestResult[];
    baseline?: ReadonlySet<string> | null;
    changes?: DiffResult | null;
    agent?: ReadonlyMap<number, string> | null;
}
export declare function computeRelevance(input: RelevanceInput): DiffPayload | null;
export interface AgentTestRef {
    name?: unknown;
    className?: unknown;
    reason?: unknown;
}
export declare function matchAgentTests(results: readonly TestResult[], refs: readonly AgentTestRef[]): {
    tags: Map<number, string>;
    unmatched: string[];
};
