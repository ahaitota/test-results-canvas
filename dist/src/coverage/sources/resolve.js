// Works out where the files named in a coverage report actually live on this
// machine.
//
// Reports rarely use full paths, so we try in order: the path as written, then
// each source folder the report declares, then the project root, then a search
// for a file on disk whose path ends the same way.
//
// Not finding a file is fine. A report copied from CI names paths that don't
// exist here; those files keep their percentages, they just can't show source.
//
// Everything here reads the disk. The plain string helpers are in paths.ts.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { commonSuffixSegments, normalizeSlashes } from "./paths.js";
// Files that mark the top of a project. Ordered by how definitive they are.
const ROOT_MARKERS = [".git", "package.json", "pom.xml", "build.gradle", "build.gradle.kts", "go.mod", "Cargo.toml", "pyproject.toml", "setup.py"];
const ROOT_GLOB_MARKERS = [/\.sln$/i, /\.csproj$/i, /\.fsproj$/i];
// Skipped wherever they turn up: none of these ever holds hand-written source.
// "build" stays here despite being a plausible source folder name, because
// Gradle writes one per module and its generated/ subtree does hold .java.
const IGNORE_DIRS = new Set([
    "node_modules", ".git", ".hg", ".svn", ".vs", ".idea", ".venv", "venv",
    "bin", "obj", "dist", "out", "build", "target", "__pycache__",
    ".next", ".nuxt", ".gradle",
]);
// Skipped only at the top of the project, where it is report output. Deeper
// down it is ordinary source -- this extension's own src/coverage/ is the
// example, and excluding it by name hid the very files it measures.
const IGNORE_ROOT_DIRS = new Set(["coverage"]);
const MAX_INDEX_ENTRIES = 40000;
const MAX_INDEX_DEPTH = 12;
// Walk up from `start` looking for the top of the project, falling back to
// `start` itself.
//
// The nearest marker wins, because preferring the outermost would make a stray
// package.json in a home directory the root for everything under it. A .git
// folder wins outright.
export function findProjectRoot(start) {
    let dir = resolvePath(start);
    let fallback = null;
    for (;;) {
        for (const marker of ROOT_MARKERS) {
            if (marker === ".git") {
                if (existsSync(join(dir, marker)))
                    return dir;
                continue;
            }
            if (!fallback && existsSync(join(dir, marker)))
                fallback = dir;
        }
        if (!fallback) {
            try {
                if (readdirSync(dir).some((n) => ROOT_GLOB_MARKERS.some((re) => re.test(n))))
                    fallback = dir;
            }
            catch { /* unreadable */ }
        }
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return fallback ?? resolvePath(start);
}
// A filename -> absolute paths index of the project, built the first time it is
// needed and only when the cheaper steps have all missed. Capped so an
// unusually large repo still costs a bounded walk.
class SourceIndex {
    root;
    byName = null;
    constructor(root) {
        this.root = root;
    }
    lookup(name) {
        if (!this.byName)
            this.byName = this.build();
        return this.byName.get(name.toLowerCase()) ?? [];
    }
    build() {
        const map = new Map();
        let budget = MAX_INDEX_ENTRIES;
        const stack = [{ dir: this.root, depth: 0 }];
        while (stack.length) {
            const { dir, depth } = stack.pop();
            let entries;
            try {
                entries = readdirSync(dir, { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const ent of entries) {
                if (--budget < 0)
                    return map;
                if (ent.isDirectory()) {
                    const name = ent.name.toLowerCase();
                    if (depth >= MAX_INDEX_DEPTH || IGNORE_DIRS.has(name))
                        continue;
                    if (depth === 0 && IGNORE_ROOT_DIRS.has(name))
                        continue;
                    stack.push({ dir: join(dir, ent.name), depth: depth + 1 });
                    continue;
                }
                if (!ent.isFile())
                    continue;
                const key = ent.name.toLowerCase();
                const list = map.get(key);
                if (list)
                    list.push(join(dir, ent.name));
                else
                    map.set(key, [join(dir, ent.name)]);
            }
        }
        return map;
    }
}
function existsFile(p) {
    try {
        return statSync(p).isFile();
    }
    catch {
        return false;
    }
}
// A report is untrusted input -- it can name any path on this machine, and
// whatever is resolved here is what the /source route reads. Candidates are
// therefore kept inside the project the report belongs to, tested after
// symlinks are followed so neither an absolute path, a "..", nor a link can
// point outside it. Without a project root nothing can be trusted, so nothing
// resolves.
//
// The candidate itself is returned rather than its canonical form: they name
// the same file, and the spelling the rest of the pipeline uses stays put.
function createContainment(projectRoot) {
    let trusted;
    if (projectRoot) {
        try {
            trusted = realpathSync.native(resolvePath(projectRoot));
        }
        catch {
            trusted = resolvePath(projectRoot);
        }
    }
    return (candidate) => {
        if (!trusted)
            return candidate;
        let real;
        try {
            real = realpathSync.native(candidate);
        }
        catch {
            return undefined;
        }
        if (real !== trusted && !real.startsWith(trusted + sep))
            return undefined;
        return candidate;
    };
}
// Tries each way of locating one report path, cheapest first, and remembers
// what it found.
function createSourceResolver(options = {}) {
    const { projectRoot } = options;
    // A root is relative to the project the report describes, not to wherever
    // this process happens to be running. Only roots that exist here are worth
    // trying; a CI report's roots usually don't.
    const roots = (options.sourceRoots ?? [])
        .map((r) => (projectRoot ? resolvePath(projectRoot, String(r)) : resolvePath(String(r))))
        .filter((r) => existsSync(r));
    const index = projectRoot && existsSync(projectRoot) ? new SourceIndex(projectRoot) : null;
    const cache = new Map();
    const inProject = createContainment(projectRoot);
    function attempt(reportPath) {
        const raw = String(reportPath || "").trim();
        if (!raw)
            return { viaIndex: false };
        // A path in this platform's own separator: the report may use the other
        // one, and join()/statSync() want ours.
        const native = raw.split(/[\\/]/).join(sep);
        // A candidate landing outside the project falls through to the next way
        // of finding the file rather than ending the search.
        if (isAbsolute(native) && existsFile(native)) {
            const hit = inProject(resolvePath(native));
            if (hit)
                return { absPath: hit, viaIndex: false };
        }
        for (const root of roots) {
            const candidate = resolvePath(root, native);
            if (!existsFile(candidate))
                continue;
            const hit = inProject(candidate);
            if (hit)
                return { absPath: hit, viaIndex: false };
        }
        if (projectRoot) {
            const candidate = resolvePath(projectRoot, native);
            if (existsFile(candidate)) {
                const hit = inProject(candidate);
                if (hit)
                    return { absPath: hit, viaIndex: false };
            }
        }
        // Last resort: match on filename, keeping whichever candidate shares the
        // most trailing folders. That is what separates src/app/Calc.cs from
        // vendor/Calc.cs. Two candidates sharing the best score name the file
        // equally well, and choosing between them would be a coin toss.
        if (index) {
            const candidates = index.lookup(basename(native));
            let best;
            let bestScore = 0;
            let tied = 0;
            for (const candidate of candidates) {
                const score = commonSuffixSegments(raw, candidate);
                if (score > bestScore) {
                    bestScore = score;
                    best = candidate;
                    tied = 1;
                }
                else if (score === bestScore)
                    tied++;
            }
            // One shared segment is only the filename, too weak to act on
            // unless nothing else in the project has that name.
            if (best && tied === 1 && (bestScore > 1 || candidates.length === 1)) {
                return { absPath: inProject(best), viaIndex: true };
            }
        }
        return { viaIndex: false };
    }
    return {
        projectRoot,
        resolve(reportPath) {
            const cached = cache.get(reportPath);
            if (cached)
                return cached;
            const resolved = attempt(reportPath);
            cache.set(reportPath, resolved);
            return resolved;
        },
    };
}
// Fill in `absPath` for every file in a report. Returns a new report, leaving
// the parse result untouched so it stays reusable.
export function resolveReportSources(report, options = {}) {
    const resolver = createSourceResolver({ sourceRoots: report.sourceRoots, ...options });
    // Normalise slashes once here rather than in each parser. A Windows LCOV
    // writes "src\ask.ts" while git always says "src/ask.ts", and left alone
    // the same file would appear twice in patch coverage.
    const resolved = report.files.map((f) => ({ file: f, hit: resolver.resolve(f.path) }));
    // Entries are distinct files, so a guessed name that several of them landed
    // on identifies none of them. An aggregate JaCoCo report is the case that
    // matters: api/…/Util.java and worker/…/Util.java are two modules, and a
    // project holding one Util.java would otherwise show its source for both.
    const guessed = new Map();
    for (const { hit } of resolved) {
        if (hit.viaIndex && hit.absPath)
            guessed.set(hit.absPath, (guessed.get(hit.absPath) ?? 0) + 1);
    }
    const files = resolved.map(({ file, hit }) => ({
        ...file,
        path: normalizeSlashes(file.path),
        absPath: hit.absPath && hit.viaIndex && guessed.get(hit.absPath) > 1 ? undefined : hit.absPath,
    }));
    return { ...report, files };
}
//# sourceMappingURL=resolve.js.map