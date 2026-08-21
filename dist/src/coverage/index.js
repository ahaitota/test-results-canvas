// The coverage subsystem's public API.
//
// Everything the rest of the server needs is re-exported here, so callers name
// one module instead of reaching into internals.
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
// Read one report and derive everything: parse, resolve, diff, rank, summarise.
export { loadCoverageFile } from "./load.js";
// Find the report belonging to a results file, without being told where it is.
export { discoverCoverageFor, newestCoverageFileIn } from "./discover.js";
// One file's source text, annotated with hits and diff status.
export { readSourceView } from "./sources/view.js";
// What to tell the user when a run produced no coverage at all.
export { suggestCoverageCommand } from "./suggest.js";
// --- supporting helpers the server uses directly --------------------------
// Is this filename worth opening when hunting for a report?
export { hasCoverageExt } from "./formats/detect.js";
// Where does the project containing this path begin?
export { findProjectRoot } from "./sources/resolve.js";
// Collapses a line list into "13-18, 22" for prompts and notes.
export { toRanges } from "./analysis/patch.js";
export { percentOf } from "./model/totals.js";
//# sourceMappingURL=index.js.map