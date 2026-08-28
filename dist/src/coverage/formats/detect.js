// Works out which of the three coverage formats a file is, by looking at its
// contents rather than its name. CI pipelines rename reports freely, and
// Cobertura and JaCoCo share the .xml extension with the JUnit result files
// this canvas already reads.
import { parseCobertura } from "./cobertura.js";
import { parseLcov } from "./lcov.js";
import { parseJacoco } from "./jacoco.js";
// Extensions worth opening at all when hunting for a report.
const COVERAGE_EXTS = [".xml", ".info", ".lcov", ".dat", ".cobertura"];
// Filenames that are almost certainly coverage, used to rank candidates when a
// directory holds several plausible files.
const PREFERRED_NAMES = [
    "coverage.cobertura.xml",
    "cobertura-coverage.xml",
    "cobertura.xml",
    "jacoco.xml",
    "jacocotestreport.xml",
    "lcov.info",
    "coverage.xml",
];
// Only the start of the file is read: these markers all appear early, and a
// report for a large repo can be tens of megabytes.
const SNIFF_CHARS = 8192;
export function detectCoverageFormat(content) {
    const head = String(content || "").slice(0, SNIFF_CHARS);
    if (!head.trim())
        return null;
    // LCOV is line-oriented; an SF: record is unambiguous.
    if (/^\s*SF:.+$/m.test(head) && /^\s*(DA:|end_of_record|FN:|LF:)/m.test(head))
        return "lcov";
    // JaCoCo is checked first: its root element is distinctive, and some tools
    // wrap it in something that also looks like Cobertura's <coverage>.
    if (/<report\b/i.test(head) && (/JACOCO/i.test(head) || /<sourcefile\b/i.test(head) || /<package\b/i.test(head)))
        return "jacoco";
    if (/<coverage\b/i.test(head) && /(line-rate|<packages\b|<sources\b|<class\b)/i.test(head))
        return "cobertura";
    return null;
}
export function looksLikeCoverage(content) {
    return detectCoverageFormat(content) !== null;
}
// Returns null when the content isn't a coverage report, so callers can keep
// looking instead of failing.
export function parseCoverage(content) {
    switch (detectCoverageFormat(content)) {
        case "cobertura": return parseCobertura(content);
        case "lcov": return parseLcov(content);
        case "jacoco": return parseJacoco(content);
        default: return null;
    }
}
// Higher is a better guess when several coverage files sit side by side.
export function nameScore(fileName) {
    const lower = fileName.toLowerCase();
    const idx = PREFERRED_NAMES.indexOf(lower);
    if (idx >= 0)
        return PREFERRED_NAMES.length - idx;
    return lower.includes("coverage") || lower.includes("lcov") || lower.includes("jacoco") ? 1 : 0;
}
// Cheap pre-filter before a file is read from disk.
export function hasCoverageExt(fileName) {
    const lower = fileName.toLowerCase();
    return COVERAGE_EXTS.some((e) => lower.endsWith(e));
}
//# sourceMappingURL=detect.js.map