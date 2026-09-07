import type { TestResult } from "../types.js";
export interface Parser {
    id: string;
    exts: readonly string[];
    detect(head: string): boolean;
    parse(text: string): TestResult[];
    wellFormed?(text: string): boolean;
    expand?(abs: string): string[];
}
export declare const PARSERS: readonly Parser[];
export declare const RESULT_EXTS: readonly string[];
export declare function detectParser(text: unknown): Parser | undefined;
export declare function looksLikeResults(text: unknown): boolean;
export declare function parseResults(text: string): TestResult[] | null;
export declare function parseResultsAt(abs: string): TestResult[] | null;
export declare function expandsDirectory(abs: string): boolean;
export declare function runKey(abs: string): string;
export declare function canonicalResultPaths(paths: readonly string[]): string[];
