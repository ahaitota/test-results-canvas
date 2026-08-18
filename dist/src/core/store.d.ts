import type { CanvasState, TestResult, TestStatus } from "../types.js";
export declare const RESULT_EXTS: string[];
export declare function looksLikeResults(xml: unknown): boolean;
export declare function newestResultsFileIn(dir: string): string | null;
export declare function normalizeStatus(raw: unknown): TestStatus;
export interface ResultInput {
    name: string;
    status: unknown;
    durationMs?: number;
    message?: string;
}
export interface ResultsStoreOptions {
    rootDir: string;
    resultsFile?: string;
    resultsDir?: string;
    title?: string;
    watch?: boolean;
    alsoRegister?: string[];
}
export declare class ResultsStore {
    readonly title: string;
    private readonly root;
    private readonly samplesDir;
    private readonly watchEnabled;
    private readonly discovered;
    private readonly listeners;
    private watcher;
    private results;
    private file;
    constructor(options: ResultsStoreOptions);
    state(): CanvasState;
    getResults(): TestResult[];
    currentFile(): string;
    resolveResultPath(name: unknown): string | null;
    onChange(listener: (state: CanvasState) => void): () => void;
    emit(): void;
    register(paths: string[]): void;
    setResults(list: ResultInput[]): number;
    addResult(t: ResultInput): number;
    clearResults(): void;
    loadNamed(name: string): boolean;
    loadInput(input?: {
        resultsFile?: string;
        resultsDir?: string;
    }): string | null;
    dispose(): void;
    private toResult;
    private labelFor;
    private listLocalNames;
    private listResultFiles;
    private loadFile;
    private persist;
    private registerSamples;
    private seed;
    private adopt;
    private refreshFromDir;
    private watchDir;
    private stopWatcher;
}
