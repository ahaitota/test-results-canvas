import type { SourceFileView } from "./payload.js";
import type { LoadedCoverage } from "./load.js";
export type { SourceLine, SourceFileView } from "./payload.js";
export type SourceError = "unknown-file" | "no-source" | "unreadable";
export declare function readSourceView(loaded: LoadedCoverage, path: string): SourceFileView | SourceError;
