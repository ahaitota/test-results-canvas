// Tells application code apart from tests, generated output and non-code files.
// Pure string matching, so it can run anywhere and needs no filesystem access.
import { normalizeSlashes } from "./paths.js";
const SOURCE_EXTS = [
    ".cs", ".fs", ".vb",
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
    ".java", ".kt", ".kts", ".scala", ".groovy",
    ".py", ".rb", ".php", ".go", ".rs", ".swift", ".m", ".mm", ".dart",
    ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp",
];
const TEST_DIR_RE = /(^|\/)([^/]*\.)?(tests?|specs?|__tests__|__specs__|e2e|integration-tests?)(\/|$)/i;
// .NET names a test project for what it tests: App.UnitTests, App.IntegrationTests.
// Case-sensitive on the capital, so Contoso.Protests stays production code.
const TEST_PROJECT_RE = /(^|\/)[A-Za-z0-9_]+\.[A-Za-z0-9_]*(Tests?|Specs?)(\/|$)/;
const TEST_FILE_RE = /(^|\/)(test_[^/]*|[^/]*_test|[^/]*[.-](test|spec)s?)\.[a-z0-9]+$/i;
// Names carrying no separator, like CalculatorTests.cs, where the capital is the
// only boundary -- so this one is case-sensitive on purpose: contest.ts and
// latest.ts are production code. Separator forms are TEST_FILE_RE's job.
const TEST_SUFFIX_RE = /(^|\/)(tests?|specs?|testcase|testfixture)\.[A-Za-z0-9]+$|(^|\/)[A-Za-z0-9_]*(Tests?|Specs?|TestCase|TestFixture)\.[A-Za-z0-9]+$/;
// Machine-written code, where uncovered lines are normal rather than a problem.
// Build output counts because this repo commits its dist/. "coverage" is
// deliberately not here -- it is as often real source, like this extension's
// own src/coverage/ -- and "build" only matches at the root for the same reason.
const GENERATED_RE = /(\.(g|generated|designer)\.[a-z0-9]+$)|(\.min\.(js|css)$)|(\.pb\.go$)|(_pb2\.py$)|(\.freezed\.dart$)|(\.d\.[cm]?ts$)|(^build\/)|((^|\/)(migrations|generated|__generated__|node_modules|obj|bin|dist|out|target|vendor|__pycache__|venv|\.venv|\.next|\.nuxt)(\/|$))/i;
function fileExt(path) {
    const name = normalizeSlashes(path).split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot).toLowerCase() : "";
}
function isSourcePath(path) {
    return SOURCE_EXTS.includes(fileExt(path));
}
export function isTestPath(path) {
    const p = normalizeSlashes(path);
    return TEST_DIR_RE.test(p) || TEST_PROJECT_RE.test(p) || TEST_FILE_RE.test(p) || TEST_SUFFIX_RE.test(p);
}
export function isGeneratedPath(path) {
    return GENERATED_RE.test(normalizeSlashes(path));
}
// The code a user actually wants covered.
export function isProductionSource(path) {
    return isSourcePath(path) && !isTestPath(path) && !isGeneratedPath(path);
}
//# sourceMappingURL=classify.js.map