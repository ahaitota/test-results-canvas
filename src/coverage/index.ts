// The coverage subsystem's public API. Everything the rest of the server needs
// is re-exported here, so callers name one module instead of reaching into
// internals.
//
// IMPORTANT: this module reaches the filesystem and git, so the browser must
// not import it. The client's contract is `model/payload.js`, which is types
// only and free of node imports.
//
// The pipeline, in the order the data flows:
//
//   discover  find the report that belongs with a results file
//   formats   work out the format and parse it into the model
//   sources   locate the real files on disk, and read them back
//   analysis  cross with the git diff, then rank what is worth testing
//   load      run all of the above and build the payload the panel renders

// --- entry points ---------------------------------------------------------

export { loadCoverageFile } from "./load.js";
export type { LoadedCoverage, LoadOptions, CoverageLoadResult, CoverageLoadFailure } from "./load.js";

export { discoverCoverageFor, newestCoverageFileIn } from "./discover.js";

export { readSourceView } from "./sources/view.js";
export type { SourceError } from "./sources/view.js";

export { suggestCoverageCommand } from "./suggest.js";

// --- supporting helpers the server uses directly --------------------------

export { hasCoverageExt } from "./formats/detect.js";

export { findProjectRoot } from "./sources/resolve.js";

export { toRanges } from "./analysis/patch.js";

// Diff mode reads the same change set the coverage tab does.
export { changedLines } from "./analysis/gitdiff.js";
export type { DiffResult } from "./analysis/gitdiff.js";

export { isGeneratedPath } from "./sources/classify.js";

// Injection point for git, so tests can run without a repository.
export type { GitExec } from "./analysis/gitdiff.js";

// --- the wire contract ----------------------------------------------------
// Re-exported for the server's convenience. The client imports these from
// `model/payload.js` directly, never from here.

export type {
    CoveragePayload,
    CoverageFileSummary,
    CoverageSuggestion,
    PatchCoverage,
    PatchFile,
    SourceFileView,
    SourceLine,
    UncoveredRegion,
} from "./model/payload.js";

// --- the data model -------------------------------------------------------

export type {
    BranchTotals,
    CoverageFile,
    CoverageFormat,
    CoverageReport,
    CoverageTotals,
    LineHits,
} from "./model/types.js";

export { percentOf } from "./model/totals.js";