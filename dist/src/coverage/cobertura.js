// Cobertura XML coverage parser. The most widely emitted dialect: coverlet
// writes it for `dotnet test --collect:"XPlat Code Coverage"`, and coverage.py,
// gcovr, simplecov and phpunit can all produce it.
//
//   <coverage><sources><source>/repo/root</source></sources>
//     <packages><package><classes>
//       <class filename="MyApp/Calculator.cs">
//         <lines><line number="5" hits="3" branch="False"/></lines>
//
// One source file can appear as several <class> elements -- partial classes, or
// simply more than one type per file -- so entries are emitted per class and
// merged by filename in buildFiles().
import { scanTags, attr, numAttr } from "../xml.js";
import { buildFiles, totalsOf } from "./types.js";
// coverlet writes `condition-coverage="50% (1/2)"`; the fraction is the part
// worth keeping, since the percentage is derivable and lossy.
function parseConditionCoverage(raw) {
    const m = /\((\d+)\s*\/\s*(\d+)\)/.exec(String(raw || ""));
    if (!m)
        return null;
    const covered = Number(m[1]);
    const total = Number(m[2]);
    if (!Number.isFinite(covered) || !Number.isFinite(total) || total <= 0)
        return null;
    return { covered, total };
}
export function parseCobertura(xml) {
    const text = String(xml || "");
    const sourceRoots = [];
    const entries = [];
    // Current <class> being filled; null while outside one.
    let current = null;
    for (const tag of scanTags(text)) {
        const name = tag.name.toLowerCase();
        if (name === "source" && !tag.closing && !tag.selfClosing) {
            // <source> holds text, not attributes: read up to its close tag.
            const close = text.indexOf("<", tag.end);
            const value = text.slice(tag.end, close < 0 ? text.length : close).trim();
            if (value)
                sourceRoots.push(value);
            continue;
        }
        if (name === "class") {
            if (tag.closing || tag.selfClosing) {
                // A self-closing <class/> carries no lines, so only a real close
                // tag can end a class that collected any.
                if (current && tag.closing) {
                    entries.push({
                        path: current.path,
                        lines: current.lines,
                        branches: current.branchTotal > 0 ? { covered: current.branchCovered, total: current.branchTotal } : undefined,
                    });
                    current = null;
                }
                continue;
            }
            const filename = attr(tag.attrs, "filename");
            current = filename ? { path: filename, lines: {}, branchCovered: 0, branchTotal: 0 } : null;
            continue;
        }
        if (name === "line" && !tag.closing && current) {
            const number = numAttr(tag.attrs, "number");
            if (number == null || !Number.isInteger(number) || number < 1)
                continue;
            const hits = numAttr(tag.attrs, "hits") ?? 0;
            // Highest wins: the same line can be listed twice for a partial
            // class, and "executed at least once" is what the UI shows.
            current.lines[number] = Math.max(current.lines[number] ?? 0, Math.max(0, Math.trunc(hits)));
            const branches = parseConditionCoverage(attr(tag.attrs, "condition-coverage"));
            if (branches) {
                current.branchCovered += branches.covered;
                current.branchTotal += branches.total;
            }
        }
    }
    // A truncated report can end mid-class; keep what was collected.
    if (current) {
        entries.push({
            path: current.path,
            lines: current.lines,
            branches: current.branchTotal > 0 ? { covered: current.branchCovered, total: current.branchTotal } : undefined,
        });
    }
    const files = buildFiles(entries);
    return { format: "cobertura", files, totals: totalsOf(files), sourceRoots };
}
//# sourceMappingURL=cobertura.js.map