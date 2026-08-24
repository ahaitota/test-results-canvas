export declare function normalizeSlashes(p: string): string;
export declare function commonSuffixSegments(a: string, b: string): number;
export declare function isSamePathOrSuffix(a: string, b: string): boolean;
export declare function findByPath<T>(entries: ReadonlyMap<string, T>, path: string): T | undefined;
