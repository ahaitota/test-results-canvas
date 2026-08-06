// Coverage report format detection.
//
// Reports are identified by their *content*, not their filename: collectors and
// CI pipelines rename them freely (`coverage.cobertura.xml`, `cobertura.xml`,
// `coverage.xml`, `lcov.info`, `lcov.dat`), and both Cobertura and JaCoCo share
// the `.xml` extension with the JUnit result files this canvas already reads.
// Sniffing keeps those apart and lets an oddly named report still work.
import { parseCobertura } from "./cobertura.js";
import { parseLcov } from "./lcov.js";
import { parseJacoco } from "./jacoco.js";
// Extensions worth opening at all when hunting for a report.
export const COVERAGE_EXTS = [".xml", ".info", ".lcov", ".dat", ".cobertura"];
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
// Only the head of the file is inspected: these markers all appear early, and a
// coverage report for a large repo can be tens of megabytes.
const SNIFF_CHARS = 8192;
export function detectCoverageFormat(content) {
    const head = String(content || "").slice(0, SNIFF_CHARS);
    if (!head.trim())
        return null;
    // LCOV is line-oriented; `SF:` starts a record and is unambiguous.
    if (/^\s*SF:.+$/m.test(head) && /^\s*(DA:|end_of_record|FN:|LF:)/m.test(head))
        return "lcov";
    // JaCoCo checked before Cobertura: its DTD/report root is distinctive, and
    // some toolchains wrap it in a <coverage>-like element.
    if (/<report\b/i.test(head) && (/JACOCO/i.test(head) || /<sourcefile\b/i.test(head) || /<package\b/i.test(head)))
        return "jacoco";
    if (/<coverage\b/i.test(head) && /(line-rate|<packages\b|<sources\b|<class\b)/i.test(head))
        return "cobertura";
    return null;
}
// True when the content is a coverage report of any supported dialect.
export function looksLikeCoverage(content) {
    return detectCoverageFormat(content) !== null;
}
// Parse using the detected dialect. Returns null when the content isn't a
// coverage report, so callers can keep scanning rather than surface an error.
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
