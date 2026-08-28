export type RelevanceKind = "new" | "modified" | "impacted";
export interface TestRelevance {
    kind: RelevanceKind;
    reason: string;
    fromAgent?: boolean;
}
export type RelevanceTags = Record<number, TestRelevance>;
export interface RelevanceCounts {
    new: number;
    modified: number;
    impacted: number;
    relevant: number;
}
export interface DiffPayload {
    against: string;
    tags: RelevanceTags;
    counts: RelevanceCounts;
    changedFiles: number;
    files: string[];
    hasBaseline: boolean;
}
