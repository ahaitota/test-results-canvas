import type { ResultInput } from "./server.js";
export declare function asString(value: unknown): string | undefined;
export declare function asNumber(value: unknown): number | undefined;
export declare function asResultInput(value: unknown): ResultInput | null;
export declare const MAX_SOURCE_PATHS = 64;
export declare function asStringArray(value: unknown, max?: number): string[];
export declare function asOpenInput(input: {
    [k: string]: unknown;
} | undefined): {
    name?: string;
    resultsFile?: string;
    resultsDir?: string;
    resultsFiles?: string[];
    coverageFile?: string;
    coverageDir?: string;
};
export declare function asFilesInput(input: {
    [k: string]: unknown;
} | undefined): {
    name?: string;
    files: string[];
};
