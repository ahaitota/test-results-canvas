export type RevealMode = "reveal" | "open";
export interface RevealTarget {
    kind: "file" | "dir";
    path: string;
}
export interface Launch {
    command: string;
    args: string[];
}
export declare function commonParent(paths: readonly string[], platform: NodeJS.Platform): string | null;
export declare function launchFor(mode: RevealMode, target: RevealTarget, platform: NodeJS.Platform): Launch | null;
