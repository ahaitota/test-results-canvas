export declare function normalizeSlashes(p: string): string;
export declare function commonSuffixSegments(a: string, b: string): number;
export declare function matchPath<T>(wanted: readonly (string | undefined)[], candidates: readonly T[], spellingsOf: (candidate: T) => readonly (string | undefined)[]): T | undefined;
export declare function findByPath<T>(entries: ReadonlyMap<string, T>, path: string): T | undefined;
