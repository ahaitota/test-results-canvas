// Turns the paths inside a coverage report into real files on this machine.
//
// No dialect is reliably absolute, so resolution is a cascade -- absolute, each
// declared source root, the project root, then a suffix match against files on
// disk -- and it may fail. A report copied from CI legitimately points at paths
// that do not exist here; those files keep their percentages and just cannot
// open a source view.

import { existsSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import type { CoverageFile, CoverageReport } from "./types.js";

// Files that mark the top of a project. Ordered by how definitive they are.
const ROOT_MARKERS = [".git", "package.json", "pom.xml", "build.gradle", "build.gradle.kts", "go.mod", "Cargo.toml", "pyproject.toml", "setup.py"];
const ROOT_GLOB_MARKERS = [/\.sln$/i, /\.csproj$/i, /\.fsproj$/i];

const IGNORE_DIRS = new Set([
    "node_modules", ".git", ".hg", ".svn", ".vs", ".idea", ".venv", "venv",
    "bin", "obj", "dist", "out", "build", "target", "coverage", "__pycache__",
    ".next", ".nuxt", ".gradle", "packages",
]);

const MAX_INDEX_ENTRIES = 40000;
const MAX_INDEX_DEPTH = 12;

// Report paths use whichever separator the collector's platform used; compare
// everything in forward slashes.
export function normalizeSlashes(p: string): string {
    return String(p || "").replace(/\\/g, "/");
}

// Walk up from `start` to the top of the project, falling back to `start`.
//
// The *nearest* marker wins: preferring the outermost makes a stray
// package.json in a home directory the root for everything beneath it. A .git
// still wins outright.
export function findProjectRoot(start: string): string {
    let dir = resolvePath(start);
    let fallback: string | null = null;
    for (;;) {
        for (const marker of ROOT_MARKERS) {
            if (marker === ".git") {
                if (existsSync(join(dir, marker))) return dir;
                continue;
            }
            if (!fallback && existsSync(join(dir, marker))) fallback = dir;
        }
        if (!fallback) {
            try {
                if (readdirSync(dir).some((n) => ROOT_GLOB_MARKERS.some((re) => re.test(n)))) fallback = dir;
            } catch { /* unreadable */ }
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return fallback ?? resolvePath(start);
}

// Lazily built basename -> absolute paths index, used only when the cheaper
// resolution steps all miss. Capped so a pathological repo costs a bounded walk.
class SourceIndex {
    private byName: Map<string, string[]> | null = null;

    constructor(private readonly root: string) {}

    lookup(name: string): string[] {
        if (!this.byName) this.byName = this.build();
        return this.byName.get(name.toLowerCase()) ?? [];
    }

    private build(): Map<string, string[]> {
        const map = new Map<string, string[]>();
        let budget = MAX_INDEX_ENTRIES;
        const stack: { dir: string; depth: number }[] = [{ dir: this.root, depth: 0 }];
        while (stack.length) {
            const { dir, depth } = stack.pop()!;
            let entries: Dirent[];
            try {
                entries = readdirSync(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const ent of entries) {
                if (--budget < 0) return map;
                if (ent.isDirectory()) {
                    if (depth >= MAX_INDEX_DEPTH || IGNORE_DIRS.has(ent.name.toLowerCase())) continue;
                    stack.push({ dir: join(dir, ent.name), depth: depth + 1 });
                    continue;
                }
                if (!ent.isFile()) continue;
                const key = ent.name.toLowerCase();
                const list = map.get(key);
                if (list) list.push(join(dir, ent.name));
                else map.set(key, [join(dir, ent.name)]);
            }
        }
        return map;
    }
}

// How many trailing path segments two paths share. Used to choose between
// several same-named files (`src/Calc.cs` vs `tests/Calc.cs`).
export function commonSuffixSegments(a: string, b: string): number {
    const left = normalizeSlashes(a).toLowerCase().split("/").filter(Boolean);
    const right = normalizeSlashes(b).toLowerCase().split("/").filter(Boolean);
    let n = 0;
    while (n < left.length && n < right.length && left[left.length - 1 - n] === right[right.length - 1 - n]) n++;
    return n;
}

function existsFile(p: string): boolean {
    try {
        return statSync(p).isFile();
    } catch {
        return false;
    }
}

interface ResolverOptions {
    sourceRoots?: readonly string[];
    projectRoot?: string;
}

interface SourceResolver {
    projectRoot?: string;
    resolve(reportPath: string): string | undefined;
}

function createSourceResolver(options: ResolverOptions = {}): SourceResolver {
    const { projectRoot } = options;
    // Only roots that exist here are worth trying; a CI report's roots usually
    // do not.
    const roots = (options.sourceRoots ?? []).map((r) => resolvePath(String(r))).filter((r) => existsSync(r));
    const index = projectRoot && existsSync(projectRoot) ? new SourceIndex(projectRoot) : null;
    const cache = new Map<string, string | undefined>();

    function attempt(reportPath: string): string | undefined {
        const raw = String(reportPath || "").trim();
        if (!raw) return undefined;
        // A native path for this platform: the report may use the other
        // separator, and join()/statSync() want ours.
        const native = raw.split(/[\\/]/).join(sep);

        if (isAbsolute(native) && existsFile(native)) return resolvePath(native);

        for (const root of roots) {
            const candidate = resolvePath(root, native);
            if (existsFile(candidate)) return candidate;
        }
        if (projectRoot) {
            const candidate = resolvePath(projectRoot, native);
            if (existsFile(candidate)) return candidate;
        }

        // Match by name and keep the candidate sharing the most trailing
        // segments -- what distinguishes `src/app/Calc.cs` from
        // `vendor/Calc.cs`.
        if (index) {
            let best: string | undefined;
            let bestScore = 0;
            for (const candidate of index.lookup(basename(native))) {
                const score = commonSuffixSegments(raw, candidate);
                if (score > bestScore) {
                    bestScore = score;
                    best = candidate;
                }
            }
            // One shared segment is just the filename, which is too weak to act
            // on unless it is the only file with that name in the project.
            if (best && (bestScore > 1 || index.lookup(basename(native)).length === 1)) return best;
        }
        return undefined;
    }

    return {
        projectRoot,
        resolve(reportPath: string): string | undefined {
            if (cache.has(reportPath)) return cache.get(reportPath);
            const resolved = attempt(reportPath);
            cache.set(reportPath, resolved);
            return resolved;
        },
    };
}

// Fill in `absPath` for every file in a report. Returns a new report; the input
// is left untouched so a parse result stays reusable.
export function resolveReportSources(report: CoverageReport, options: ResolverOptions = {}): CoverageReport {
    const resolver = createSourceResolver({ sourceRoots: report.sourceRoots, ...options });
    // Settled on forward slashes here rather than per format: a Windows LCOV
    // writes "src\ask.ts" while git always says "src/ask.ts", and left alone the
    // same file shows up twice in patch coverage.
    const files: CoverageFile[] = report.files.map((f) => ({
        ...f,
        path: normalizeSlashes(f.path),
        absPath: resolver.resolve(f.path),
    }));
    return { ...report, files };
}
