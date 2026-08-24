export declare function normalizeSlashes(p: string): string;
export declare function commonSuffixSegments(a: string, b: string): number;
export interface PathIdentity {
    absPath?: string;
    path?: string;
}
export declare function matchPath<T>(wanted: PathIdentity, all: readonly T[], identityOf: (candidate: T) => PathIdentity): T | undefined;
export declare function findByPath<T>(entries: ReadonlyMap<string, T>, path: string): T | undefined;
