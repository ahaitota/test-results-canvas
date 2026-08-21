// Reads JaCoCo XML, the Java standard — the natural partner to the
// Surefire/Gradle JUnit reports this canvas already renders.
//
//   <report><package name="com/example/app">
//     <sourcefile name="Calculator.java"><line nr="5" mi="0" ci="3"/>
//
// The attributes count instructions and branches (mi/ci = missed/covered
// instructions) rather than executions, so a covered line is stored as 1 hit.

import { scanTags, attr, numAttr } from "../../xml.js";
import { buildFiles, totalsOf } from "../model/totals.js";
import type { BranchTotals, CoverageReport, LineHits } from "../model/types.js";

export function parseJacoco(xml: string): CoverageReport {
    const entries: { path: string; lines: LineHits; branches?: BranchTotals }[] = [];

    // Package names are slash-separated ("com/example/app") and go in front of
    // the sourcefile name to make a repo-relative-looking path.
    let pkg = "";
    let current: { path: string; lines: LineHits; branchCovered: number; branchTotal: number } | null = null;

    // Finish the file being read, if any.
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
            // This format has no execution counts, so 1 just means "it ran".
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
