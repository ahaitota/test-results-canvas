export type GitExec = (args: string[]) => string | null;
export declare function createGitExec(root: string): GitExec;
export interface FileChanges {
    path: string;
    absPath: string;
    lines: Set<number>;
    all: boolean;
}
export interface DiffResult {
    root: string;
    against: string;
    files: FileChanges[];
}
export declare function parseUnifiedDiff(diff: string): Map<string, Set<number>>;
export interface DiffOptions {
    exec?: GitExec;
}
export declare function changedLines(root: string, options?: DiffOptions): DiffResult | null;
