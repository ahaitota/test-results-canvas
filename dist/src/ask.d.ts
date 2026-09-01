import type { TestResult } from "./types.js";
import type { PatchCoverage } from "./coverage/index.js";
export declare function testPath(t: TestResult): string;
export declare function composeAskPrompt(t: TestResult): string;
export interface UncoveredFile {
    path: string;
    uncoveredLines: readonly number[];
    percent: number | null;
}
export declare function composeCoveragePrompt(file: UncoveredFile): string;
export declare function composePatchCoveragePrompt(patch: PatchCoverage): string;
export declare function composeEnableCoveragePrompt(command: string, ecosystem: string, alternative?: {
    ecosystem: string;
    command: string;
}): string;
export interface ImpactRequest {
    against: string;
    files: readonly string[];
    changedFiles: number;
    totalTests: number;
}
export declare function composeImpactPrompt(req: ImpactRequest): string;
