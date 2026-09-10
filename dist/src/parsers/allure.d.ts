import type { TestResult } from "../types.js";
export declare const ALLURE_STATUS: Set<string>;
export declare function parseAllure(text: string): TestResult[];
export declare function isAllureRunFile(abs: string): boolean;
export declare function expandAllure(abs: string): string[];
