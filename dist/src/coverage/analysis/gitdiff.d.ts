export type GitExec = (args: string[]) => string | null;
export interface FileChanges {
    path: string;
    absPath: string;
    lines: Set<number>;
    all: boolean;
    lineCount?: number;
}
export interface DiffResult {
    root: string;
    against: string;
    files: FileChanges[];
}
export declare function parseUnifiedDiff(diff: string): Map<string, Set<number>>;
export interface DiffOptions {
    exec?: GitExec;
    includeTests?: boolean;
}
export declare function changedLines(root: string, options?: DiffOptions): DiffResult | null;
