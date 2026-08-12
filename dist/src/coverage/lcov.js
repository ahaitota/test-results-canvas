// LCOV coverage parser. The line-oriented tracefile the JS/TS world emits by
// default (vitest, jest, c8, nyc), and Rust and gcov produce it too. One record
// per file, terminated by end_of_record:
//
//   SF:<source file path>
//   DA:<line>,<hits>                        executable line + execution count
//   BRDA:<line>,<block>,<branch>,<taken|->   one branch outcome
//
// LF/LH/FN summary records are ignored; DA/BRDA are authoritative. Runners
// append a fresh record per test file, so the same SF: can appear many times
// over and buildFiles() sums those hits.
import { buildFiles, totalsOf } from "./types.js";
function finish(entry, out) {
    const branches = entry.branchKeys.size
        ? { covered: entry.branchTaken.size, total: entry.branchKeys.size }
        : undefined;
    out.push({ path: entry.path, lines: entry.lines, branches });
}
export function parseLcov(text) {
    const entries = [];
    let current = null;
    for (const rawLine of String(text || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line)
            continue;
        if (line === "end_of_record") {
            if (current)
                finish(current, entries);
            current = null;
            continue;
        }
        const sep = line.indexOf(":");
        if (sep < 0)
            continue;
        const tag = line.slice(0, sep).toUpperCase();
        const value = line.slice(sep + 1);
        if (tag === "SF") {
            // A missing end_of_record shouldn't swallow the previous file.
            if (current)
                finish(current, entries);
            const path = value.trim();
            current = path ? { path, lines: {}, branchKeys: new Set(), branchTaken: new Set() } : null;
            continue;
        }
        if (!current)
            continue;
        if (tag === "DA") {
            const [lineNo, hits] = value.split(",");
            const n = Number(lineNo);
            if (!Number.isInteger(n) || n < 1)
                continue;
            const count = Number(hits);
            current.lines[n] = (current.lines[n] ?? 0) + (Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0);
            continue;
        }
        if (tag === "BRDA") {
            // line,block,branch,taken -- "taken" is "-" when the line never ran.
            const parts = value.split(",");
            if (parts.length < 4)
                continue;
            const n = Number(parts[0]);
            if (!Number.isInteger(n) || n < 1)
                continue;
            const key = `${parts[0]}:${parts[1]}:${parts[2]}`;
            current.branchKeys.add(key);
            const taken = parts[3].trim();
            if (taken !== "-" && Number(taken) > 0)
                current.branchTaken.add(key);
        }
    }
    if (current)
        finish(current, entries);
    const files = buildFiles(entries);
    return { format: "lcov", files, totals: totalsOf(files), sourceRoots: [] };
}
//# sourceMappingURL=lcov.js.map