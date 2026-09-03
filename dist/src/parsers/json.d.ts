export type Rec = Record<string, unknown>;
export declare function rec(value: unknown): Rec | undefined;
export declare function str(from: Rec | undefined, key: string): string | undefined;
export declare function num(from: Rec | undefined, key: string): number | undefined;
export declare function arr(from: Rec | undefined, key: string): unknown[];
export declare function jsonLines(text: string): Rec[];
export declare function joinMessage(...parts: (string | undefined)[]): string | undefined;
