// Reads LCOV, the line-based format the JavaScript world emits by default
// (vitest, jest, c8, nyc), and which Rust and gcov also produce. One record per
// file, ended by end_of_record:
//
//   SF:<source file path>
//   DA:<line>,<hits>                         an executable line and its count
//   BRDA:<line>,<block>,<branch>,<taken|->   one branch outcome
//
// The LF/LH/FN summary records are ignored; DA and BRDA are the truth. Runners
// append a fresh record per test file, so the same SF: often appears many
// times; those records are merged here, into one entry per file.

import { buildFiles, totalsOf } from "../model/totals.js";
import { normalizeSlashes } from "../sources/paths.js";
import type { BranchTotals, CoverageReport, LineHits } from "../model/types.js";

interface Entry {
    path: string;
    lines: LineHits;
    branchKeys: Set<string>;
    branchTaken: Set<string>;
}

// Branches count once each, however many records mentioned them.
function totalsFor(entry: Entry): BranchTotals | undefined {
    return entry.branchKeys.size ? { covered: entry.branchTaken.size, total: entry.branchKeys.size } : undefined;
}

export function parseLcov(text: string): CoverageReport {
    // Keyed by file, because a runner appends a fresh record per test file and
    // the same branch then appears in several of them. Branch outcomes merge by
    // identity here; adding up each record's totals instead would count one
    // branch once per record.
    const byPath = new Map<string, Entry>();
    let current: Entry | null = null;

    for (const rawLine of String(text || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line === "end_of_record") {
            current = null;
            continue;
        }

        const sep = line.indexOf(":");
        if (sep < 0) continue;
        const tag = line.slice(0, sep).toUpperCase();
        const value = line.slice(sep + 1);

        if (tag === "SF") {
            const path = normalizeSlashes(value.trim());
            if (!path) {
                current = null;
                continue;
            }
            current = byPath.get(path) ?? { path, lines: {}, branchKeys: new Set(), branchTaken: new Set() };
            byPath.set(path, current);
            continue;
        }
        if (!current) continue;

        if (tag === "DA") {
            const [lineNo, hits] = value.split(",");
            const n = Number(lineNo);
            if (!Number.isInteger(n) || n < 1) continue;
            const count = Number(hits);
            current.lines[n] = (current.lines[n] ?? 0) + (Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0);
            continue;
        }

        if (tag === "BRDA") {
            // line,block,branch,taken -- "taken" is "-" when the line never ran.
            const parts = value.split(",");
            if (parts.length < 4) continue;
            const n = Number(parts[0]);
            if (!Number.isInteger(n) || n < 1) continue;
            const key = `${parts[0]}:${parts[1]}:${parts[2]}`;
            current.branchKeys.add(key);
            const taken = parts[3].trim();
            if (taken !== "-" && Number(taken) > 0) current.branchTaken.add(key);
        }
    }

    const files = buildFiles([...byPath.values()].map((e) => ({ path: e.path, lines: e.lines, branches: totalsFor(e) })));
    return { format: "lcov", files, totals: totalsOf(files), sourceRoots: [] };
}
