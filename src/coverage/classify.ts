// Shared path classification: tells application code apart from tests,
// generated output and non-code files. Imported by the client bundle too, so it
// stays dependency-free.

import { normalizeSlashes } from "./sources.js";

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

// Machine-written code, where uncovered lines are expected rather than a
// finding. Build output is included because this repo commits its dist/, which
// would otherwise count every changed file twice. Deliberately absent:
// `coverage`, which is as often real source (this extension's own
// src/coverage/); `build` only matches at the root for the same reason.
const GENERATED_RE = /(\.(g|generated|designer)\.[a-z0-9]+$)|(\.min\.(js|css)$)|(\.pb\.go$)|(_pb2\.py$)|(\.freezed\.dart$)|(\.d\.[cm]?ts$)|(^build\/)|((^|\/)(migrations|generated|__generated__|node_modules|obj|bin|dist|out|target|vendor|__pycache__|venv|\.venv|\.next|\.nuxt)(\/|$))/i;

function fileExt(path: string): string {
    const name = normalizeSlashes(path).split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function isSourcePath(path: string): boolean {
    return SOURCE_EXTS.includes(fileExt(path));
}

export function isTestPath(path: string): boolean {
    const p = normalizeSlashes(path);
    return TEST_DIR_RE.test(p) || TEST_FILE_RE.test(p) || TEST_SUFFIX_RE.test(p);
}

export function isGeneratedPath(path: string): boolean {
    return GENERATED_RE.test(normalizeSlashes(path));
}

// The code a user actually wants covered.
export function isProductionSource(path: string): boolean {
    return isSourcePath(path) && !isTestPath(path) && !isGeneratedPath(path);
}
