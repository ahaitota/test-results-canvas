import type { IncomingMessage, ServerResponse } from "node:http";
import type { TestResult, TestStatus } from "./types.js";
export declare const RESULT_EXTS: string[];
export declare function looksLikeResults(xml: unknown): boolean;
export declare function newestResultsFileIn(dir: string): string | null;
export declare function normalizeStatus(raw: unknown): TestStatus;
export interface ResultsServerOptions {
    resultsFile?: string;
    resultsDir?: string;
    title?: string;
    port?: number;
    watch?: boolean;
    alsoRegister?: string[];
}
export interface ResultInput {
    name: string;
    status: unknown;
    durationMs?: number;
    message?: string;
}
export type ResultsServerHandle = Awaited<ReturnType<typeof createResultsServer>>;
export declare function createResultsServer(options?: ResultsServerOptions): Promise<{
    server: import("http").Server<typeof IncomingMessage, typeof ServerResponse>;
    url: string;
    port: number;
    currentFile: () => string;
    getResults: () => TestResult[];
    setResults(list: ResultInput[]): number;
    addResult(t: ResultInput): number;
    clearResults(): void;
    loadNamed(name: string): boolean;
    loadInput(input?: {
        resultsFile?: string;
        resultsDir?: string;
    }): string | null;
    broadcast: () => void;
    reload: () => void;
    close(): Promise<void>;
}>;
