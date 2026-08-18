import type { IncomingMessage, ServerResponse } from "node:http";
import type { TestResult } from "./types.js";
export { RESULT_EXTS, looksLikeResults, newestResultsFileIn, normalizeStatus, scanForResults } from "./core/store.js";
export type { ResultInput } from "./core/store.js";
import type { ResultInput } from "./core/store.js";
export interface ResultsServerOptions {
    resultsFile?: string;
    resultsDir?: string;
    title?: string;
    port?: number;
    watch?: boolean;
    alsoRegister?: string[];
    onAsk?: (req: AskRequest) => void | Promise<void>;
}
export interface AskRequest {
    prompt: string;
    test: TestResult;
}
export type ResultsServerHandle = Awaited<ReturnType<typeof createResultsServer>>;
export declare function createResultsServer(options?: ResultsServerOptions): Promise<{
    server: import("http").Server<typeof IncomingMessage, typeof ServerResponse>;
    url: string;
    port: number;
    askToken: string;
    currentFile: () => string;
    getResults: () => TestResult[];
    setResults: (list: ResultInput[]) => number;
    addResult: (t: ResultInput) => number;
    clearResults: () => void;
    loadNamed: (name: string) => boolean;
    loadInput: (input?: {
        resultsFile?: string;
        resultsDir?: string;
    }) => string | null;
    broadcast: () => void;
    reload: () => void;
    close(): Promise<void>;
}>;
