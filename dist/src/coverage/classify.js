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
const GENERATED_RE = /(\.(g|generated|designer)\.[a-z0-9]+$)|(\.min\.(js|css)$)|(\.pb\.go$)|(_pb2\.py$)|(\.freezed\.dart$)|((^|\/)(migrations|generated|__generated__|node_modules|obj|bin)(\/|$))/i;
export function fileExt(path) {
    const name = normalizeSlashes(path).split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot).toLowerCase() : "";
}
// A file whose lines are worth talking about coverage for at all.
export function isSourcePath(path) {
    return SOURCE_EXTS.includes(fileExt(path));
}
// Test code. Its own coverage is noise: nobody writes tests for their tests.
export function isTestPath(path) {
    const p = normalizeSlashes(path);
    return TEST_DIR_RE.test(p) || TEST_FILE_RE.test(p) || TEST_SUFFIX_RE.test(p);
}
// Machine-written code. Uncovered lines here are expected, not a finding.
export function isGeneratedPath(path) {
    return GENERATED_RE.test(normalizeSlashes(path));
}
// The code a user actually wants covered.
export function isProductionSource(path) {
    return isSourcePath(path) && !isTestPath(path) && !isGeneratedPath(path);
}
