// JaCoCo XML coverage parser.
//
// JaCoCo is the Java standard, produced by the jacoco-maven-plugin
// (`target/site/jacoco/jacoco.xml`) and by Gradle's jacocoTestReport -- the
// natural companion to the Surefire/Gradle JUnit reports this canvas already
// renders. Structure:
//
//   <report name="my-app">
//     <package name="com/example/app">
//       <sourcefile name="Calculator.java">
//         <line nr="5" mi="0" ci="3" mb="0" cb="2"/>
//         <line nr="9" mi="4" ci="0" mb="2" cb="0"/>
//       </sourcefile>
//     </package>
//   </report>
//
// Attributes are instruction/branch counters, not execution counts:
//   mi/ci = missed/covered instructions, mb/cb = missed/covered branches.
// JaCoCo never records how many times a line ran, so a covered line is stored
// as a single hit; the UI shows "covered" rather than a hit count for these.

import { scanTags, attr, numAttr } from "./xml.js";
import { buildFiles, totalsOf } from "./types.js";
import type { BranchTotals, CoverageReport, LineHits } from "./types.js";

export function parseJacoco(xml: string): CoverageReport {
    const entries: { path: string; lines: LineHits; branches?: BranchTotals }[] = [];

    // Package names are slash-separated ("com/example/app") and prefix the
    // sourcefile name to give a repo-relative-looking path.
    let pkg = "";
    let current: { path: string; lines: LineHits; branchCovered: number; branchTotal: number } | null = null;

    const flush = () => {
        if (!current) return;
        entries.push({
            path: current.path,
            lines: current.lines,
            branches: current.branchTotal > 0 ? { covered: current.branchCovered, total: current.branchTotal } : undefined,
        });
        current = null;
    };

    for (const tag of scanTags(xml)) {
        const name = tag.name.toLowerCase();

        if (name === "package") {
            if (tag.closing) {
                flush();
                pkg = "";
                continue;
            }
            flush();
            pkg = (attr(tag.attrs, "name") || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
            continue;
        }

        if (name === "sourcefile") {
            if (tag.closing) {
                flush();
                continue;
            }
            flush();
            const file = attr(tag.attrs, "name");
            if (!file) continue;
            current = { path: pkg ? `${pkg}/${file}` : file, lines: {}, branchCovered: 0, branchTotal: 0 };
            if (tag.selfClosing) flush();
            continue;
        }

        if (name === "line" && !tag.closing && current) {
            const nr = numAttr(tag.attrs, "nr");
            if (nr == null || !Number.isInteger(nr) || nr < 1) continue;
            const ci = numAttr(tag.attrs, "ci") ?? 0;
            // No execution counts in this format: 1 means "was executed".
            current.lines[nr] = Math.max(current.lines[nr] ?? 0, ci > 0 ? 1 : 0);
            const cb = numAttr(tag.attrs, "cb") ?? 0;
            const mb = numAttr(tag.attrs, "mb") ?? 0;
            current.branchCovered += Math.max(0, cb);
            current.branchTotal += Math.max(0, cb) + Math.max(0, mb);
        }
    }

    flush();

    const files = buildFiles(entries);
    return { format: "jacoco", files, totals: totalsOf(files), sourceRoots: [] };
}
