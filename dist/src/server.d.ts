import type { IncomingMessage, ServerResponse } from "node:http";
import { looksLikeResults, RESULT_EXTS } from "./parsers/registry.js";
import type { AgentTestRef } from "./diff/relevance.js";
import type { CoverageLoadFailure, GitExec } from "./coverage/index.js";
import type { Launch, RevealTarget } from "./reveal.js";
import type { TestResult, TestStatus } from "./types.js";
export { RESULT_EXTS, looksLikeResults };
export declare function newestResultsFileIn(dir: string): string | null;
export declare function normalizeStatus(raw: unknown): TestStatus;
export interface SkippedPath {
    path: string;
    reason: string;
}
export interface ResultsServerOptions {
    resultsFile?: string;
    resultsDir?: string;
    resultsFiles?: readonly string[];
    name?: string;
    coverageFile?: string;
    coverageDir?: string;
    projectRoot?: string;
    title?: string;
    port?: number;
    watch?: boolean;
    alsoRegister?: string[];
    coverage?: boolean;
    gitExec?: GitExec | null;
    onAsk?: (req: AskRequest) => void | Promise<void>;
    launch?: (launch: Launch) => void | Promise<void>;
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
    name?: string;
    resultsFile?: string;
    resultsDir?: string;
    resultsFiles?: readonly string[];
    coverageFile?: string;
    coverageDir?: string;
    projectRoot?: string;
}
export interface OpenFilesResult {
    ok: boolean;
    error?: string;
    total?: number;
    sources?: {
        label: string;
        count: number;
    }[];
    skipped: SkippedPath[];
}
export interface WriteResult {
    ok: boolean;
    total?: number;
    error?: string;
}
export type ResultsServerHandle = Awaited<ReturnType<typeof createResultsServer>>;
export declare function createResultsServer(options?: ResultsServerOptions): Promise<{
    server: import("http").Server<typeof IncomingMessage, typeof ServerResponse>;
    url: string;
    port: number;
    askToken: string;
    currentFile: () => string;
    revealTarget: () => RevealTarget | null;
    getResults: () => TestResult[];
    setResults(list: ResultInput[]): WriteResult;
    addResult(t: ResultInput): WriteResult;
    clearResults(): WriteResult;
    loadNamed(name: string): boolean;
    openFiles(input: {
        name?: string;
        files: readonly string[];
    }): OpenFilesResult;
    loadInput(input?: SeedInput): string | null;
    getCoverage: () => import("./coverage/index.js").CoveragePayload | null;
    coveragePath: () => string | null;
    coverageError: () => CoverageLoadFailure | null;
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
