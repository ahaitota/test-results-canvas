// Discovery entry point — do not put logic here.
//
// The Copilot app finds extensions by scanning each extension folder for a file
// named exactly "extension.mjs". It does NOT read package.json's "main" field,
// so this file must exist at the repo root and must keep this name, or the app
// skips the folder silently and the canvas never loads.
//
// The real source is extension.ts, which compiles to dist/extension.js. This
// wrapper is the permanent front door that hands off to that build output; it
// should never need to change again.
import "./dist/extension.js";
