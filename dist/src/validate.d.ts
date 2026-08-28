import type { ResultInput } from "./server.js";
export declare function asString(value: unknown): string | undefined;
export declare function asNumber(value: unknown): number | undefined;
export declare function asResultInput(value: unknown): ResultInput | null;
export declare function asOpenInput(input: {
    [k: string]: unknown;
} | undefined): {
    resultsFile?: string;
    resultsDir?: string;
    coverageFile?: string;
    coverageDir?: string;
    projectRoot?: string;
};
