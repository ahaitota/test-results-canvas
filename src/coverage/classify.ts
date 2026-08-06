// Shared path classification.
//
// Both patch coverage and the "worth covering" ranking need to tell real
// application code apart from tests, generated output and non-code files.
// Getting this wrong is what makes coverage tools annoying: a report that keeps
// pointing at `Migrations/*.Designer.cs` teaches users to ignore it.
//
// Imported by the server and by the client bundle, so it stays dependency-free.

import { normalizeSlashes } from "./sources.js";

// Extensions we consider executable application code.
const SOURCE_EXTS = [
    ".cs", ".fs", ".vb",
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
    ".java", ".kt", ".kts", ".scala", ".groovy",
    ".py", ".rb", ".php", ".go", ".rs", ".swift", ".m", ".mm",
    ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp",
];

const TEST_DIR_RE = /(^|\/)(tests?|specs?|__tests__|__specs__|e2e|integration-tests?)(\/|$)/i;
const TEST_FILE_RE = /(^|\/)(test_[^/]*|[^/]*_test|[^/]*[.-](test|spec)s?)\.[a-z0-9]+$/i;
const TEST_SUFFIX_RE = /(tests?|spec|specs|testcase|testfixture)\.[a-z0-9]+$/i;

// Machine-written code. Uncovered lines here are expected, not a finding.
//
// Build output matters as much as codegen: a repo that commits its `dist/` (as
// this extension does, so the app can load it straight from a checkout) would
// otherwise see every changed source file counted twice -- once as source and
// once as its compiled copy -- burying the real answer under build artefacts.
// `.d.ts` files go too: declarations have no executable lines to cover.
//
// Deliberately absent: `coverage`. It reads like an output directory but is
// just as often real source -- this extension's own `src/coverage/` would
// vanish from its own report. `build` is only matched at the repo root for the
// same reason, since a nested `src/build/` is usually a module.
const GENERATED_RE = /(\.(g|generated|designer)\.[a-z0-9]+$)|(\.min\.(js|css)$)|(\.pb\.go$)|(_pb2\.py$)|(\.freezed\.dart$)|(\.d\.[cm]?ts$)|(^build\/)|((^|\/)(migrations|generated|__generated__|node_modules|obj|bin|dist|out|target|vendor|__pycache__|venv|\.venv|\.next|\.nuxt)(\/|$))/i;

export function fileExt(path: string): string {
    const name = normalizeSlashes(path).split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

// A file whose lines are worth talking about coverage for at all.
export function isSourcePath(path: string): boolean {
    return SOURCE_EXTS.includes(fileExt(path));
}

// Test code. Its own coverage is noise: nobody writes tests for their tests.
export function isTestPath(path: string): boolean {
    const p = normalizeSlashes(path);
    return TEST_DIR_RE.test(p) || TEST_FILE_RE.test(p) || TEST_SUFFIX_RE.test(p);
}

// Machine-written code -- see GENERATED_RE for what counts and why.
export function isGeneratedPath(path: string): boolean {
    return GENERATED_RE.test(normalizeSlashes(path));
}

// The code a user actually wants covered.
export function isProductionSource(path: string): boolean {
    return isSourcePath(path) && !isTestPath(path) && !isGeneratedPath(path);
}
