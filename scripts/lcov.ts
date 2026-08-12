// Reading, merging and writing LCOV. Kept pure and separate because this is
// where a mistake is silent: a path normalised two ways splits one file into two
// half-covered rows, and hit counts added twice inflate a percentage nobody
// would think to re-derive.

export interface LcovFile {
    path: string;
    // line number -> hit count
    lines: Map<number, number>;
}

// Rewrite paths from whichever tool produced them into repo-relative paths
// spelled the way git spells them, so reports from different runners describe
// the same files rather than two disjoint sets.
export function normalizePath(raw: string): string {
    const p = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    const i = p.lastIndexOf("src/");
    if (i >= 0) return p.slice(i);
    // Anything outside src/, such as extension.ts, arrives as a chain of ../
    // hops out of dist; strip them so it lands at the repo root.
    return p.replace(/^(\.\.\/)+/, "");
}

export function parseLcov(text: string): LcovFile[] {
    const files: LcovFile[] = [];
    let current: LcovFile | null = null;
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith("SF:")) {
            current = { path: normalizePath(line.slice(3).trim()), lines: new Map() };
            continue;
        }
        if (!current) continue;
        if (line.startsWith("DA:")) {
            const [rawLine, rawHits] = line.slice(3).split(",");
            const n = Number(rawLine);
            const hits = Number(rawHits);
            // A file can appear twice in one report; the same line then arrives
            // twice and the counts belong together.
            if (Number.isFinite(n) && Number.isFinite(hits)) current.lines.set(n, (current.lines.get(n) ?? 0) + hits);
            continue;
        }
        if (line.startsWith("end_of_record")) {
            if (current.lines.size) files.push(current);
            current = null;
        }
    }
    // A report truncated mid-record still has usable data in it.
    if (current?.lines.size) files.push(current);
    return files;
}

// Combine reports from different runners. Two suites can both execute a line --
// a module imported by a unit test and also loaded by the server under e2e --
// and the line is covered if either of them ran it.
export function mergeLcov(reports: readonly (readonly LcovFile[])[]): LcovFile[] {
    const byPath = new Map<string, LcovFile>();
    for (const report of reports) {
        for (const file of report) {
            // Windows and macOS filesystems are case-insensitive, and two tools
            // can disagree about the casing of the same path.
            const key = file.path.toLowerCase();
            const existing = byPath.get(key);
            if (!existing) {
                byPath.set(key, { path: file.path, lines: new Map(file.lines) });
                continue;
            }
            for (const [line, hits] of file.lines) {
                existing.lines.set(line, (existing.lines.get(line) ?? 0) + hits);
            }
        }
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function formatLcov(files: readonly LcovFile[]): string {
    const out: string[] = [];
    for (const file of files) {
        out.push(`SF:${file.path}`);
        const lines = [...file.lines.entries()].sort((a, b) => a[0] - b[0]);
        let hit = 0;
        for (const [line, hits] of lines) {
            out.push(`DA:${line},${hits}`);
            if (hits > 0) hit++;
        }
        out.push(`LF:${lines.length}`);
        out.push(`LH:${hit}`);
        out.push("end_of_record");
    }
    return out.join("\n") + "\n";
}
