import type { TestResult } from "../types.js";
export declare function serializeTrx(results: TestResult[], opts?: {
    runName?: string;
    now?: Date;
}): string;
export declare function parseTrx(xml: string): TestResult[];
