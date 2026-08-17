import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentTestRef } from "./diff/relevance.js";
import type { GitExec } from "./coverage/gitdiff.js";
import type { TestResult, TestStatus } from "./types.js";
export declare const RESULT_EXTS: string[];
export declare function looksLikeResults(xml: unknown): boolean;
export declare function newestResultsFileIn(dir: string): string | null;
export declare function normalizeStatus(raw: unknown): TestStatus;
export interface ResultsServerOptions {
    resultsFile?: string;
    resultsDir?: string;
    coverageFile?: string;
    coverageDir?: string;
    title?: string;
    port?: number;
    watch?: boolean;
    alsoRegister?: string[];
    coverage?: boolean;
    gitExec?: GitExec | null;
    onAsk?: (req: AskRequest) => void | Promise<void>;
}
export interface AskRequest {
    prompt: string;
    test?: TestResult;
    coverage?: {
        scope: "file" | "patch" | "enable";
        path?: string;
    };
    diff?: {
        scope: "impact";
    };
}
export interface ResultInput {
    name: string;
    status: unknown;
    durationMs?: number;
    message?: string;
}
export interface SeedInput {
    resultsFile?: string;
    resultsDir?: string;
    coverageFile?: string;
    coverageDir?: string;
}
export type ResultsServerHandle = Awaited<ReturnType<typeof createResultsServer>>;
export declare function createResultsServer(options?: ResultsServerOptions): Promise<{
    server: import("http").Server<typeof IncomingMessage, typeof ServerResponse>;
    url: string;
    port: number;
    askToken: string;
    currentFile: () => string;
    getResults: () => TestResult[];
    setResults(list: ResultInput[]): number;
    addResult(t: ResultInput): number;
    clearResults(): void;
    loadNamed(name: string): boolean;
    loadInput(input?: SeedInput): string | null;
    getCoverage: () => import("./coverage/payload.js").CoveragePayload | null;
    coveragePath: () => string | null;
    projectRoot: () => string | undefined;
    markImpacted(refs: readonly AgentTestRef[]): {
        matched: number;
        unmatched: string[];
    };
    clearImpacted(): void;
    loadCoverage(path: string): boolean;
    broadcast: () => void;
    reload: () => void;
    close(): Promise<void>;
}>;
