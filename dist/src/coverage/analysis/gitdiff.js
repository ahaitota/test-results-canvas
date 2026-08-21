// Asks git which lines the working tree has changed. Crossed with the coverage
// hit map (see patch.ts), this answers "did the agent test the code it just
// wrote?".
//
// Two comparisons, in order: uncommitted work against HEAD, and — if the tree
// is clean — this branch against where it forked from the default branch, so
// the answer survives the agent committing. Untracked files count as new.
//
// git is always run with a fixed argument list, never a shell string, and only
// inside the resolved project root.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { normalizeSlashes } from "../sources/paths.js";
import { isProductionSource } from "../sources/classify.js";
const GIT_TIMEOUT_MS = 5000;
const MAX_BUFFER = 16 * 1024 * 1024;
// Past this a file is generated or vendored, and its exact length tells nobody
// anything useful.
const MAX_COUNT_BYTES = 2 * 1024 * 1024;
// Runs git commands inside one project root, returning null on any failure.
function createGitExec(root) {
    return (args) => {
        try {
            return execFileSync("git", ["-C", root, ...args], {
                encoding: "utf8",
                timeout: GIT_TIMEOUT_MS,
                maxBuffer: MAX_BUFFER,
                windowsHide: true,
                stdio: ["ignore", "pipe", "ignore"],
            });
        }
        catch {
            return null;
        }
    };
}
// How many lines a file has, or undefined if it can't be read. A trailing
// newline ends the last line rather than starting an empty one.
function countLines(absPath) {
    try {
        const st = statSync(absPath);
        if (!st.isFile() || st.size > MAX_COUNT_BYTES)
            return undefined;
        const text = readFileSync(absPath, "utf8");
        if (!text)
            return 0;
        const n = text.split(/\r?\n/).length;
        return text.endsWith("\n") ? n - 1 : n;
    }
    catch {
        return undefined;
    }
}
// git quotes awkward paths as a C string: "src/a\tb.ts". Non-ASCII arrives as
// one octal escape per UTF-8 byte, so a single character can span several
// escapes — café.ts comes back as caf\303\251.ts. Decoding each escape on its
// own would give the Latin-1 reading (cafÃ©.ts), a path matching nothing in the
// report, so collect the bytes first and decode as UTF-8 once at the end.
const C_ESCAPES = { a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d };
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
// Undo git's C-style quoting on a path.
function unquotePath(raw) {
    const s = raw.trim();
    if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2)
        return s;
    const body = s.slice(1, -1);
    const bytes = [];
    // Plain runs are buffered so surrogate pairs get encoded whole.
    let literal = "";
    const flush = () => {
        for (const b of utf8Encoder.encode(literal))
            bytes.push(b);
        literal = "";
    };
    for (let i = 0; i < body.length; i++) {
        if (body[i] !== "\\") {
            literal += body[i];
            continue;
        }
        const next = body[++i];
        if (next === undefined)
            break; // trailing backslash: nothing to unescape
        flush();
        const named = C_ESCAPES[next];
        if (named !== undefined)
            bytes.push(named);
        else if (next >= "0" && next <= "7") {
            bytes.push(parseInt(body.slice(i, i + 3), 8) & 0xff);
            i += 2;
        }
        else
            bytes.push(next.charCodeAt(0)); // \\ and \"
    }
    flush();
    return utf8Decoder.decode(new Uint8Array(bytes));
}
// Turn `git diff --unified=0` output into the added line numbers per file.
//
// With no context lines the hunk header says everything: `@@ -a,b +c,d @@` means
// d lines were added starting at line c (d omitted means 1, d = 0 is a
// deletion).
export function parseUnifiedDiff(diff) {
    const byPath = new Map();
    let currentPath = null;
    for (const line of String(diff || "").split(/\r?\n/)) {
        if (line.startsWith("+++ ")) {
            const target = line.slice(4).trim();
            if (target === "/dev/null") {
                currentPath = null;
                continue;
            }
            const unquoted = unquotePath(target);
            // Strip git's "b/" destination prefix.
            currentPath = normalizeSlashes(unquoted.replace(/^b\//, ""));
            if (!byPath.has(currentPath))
                byPath.set(currentPath, new Set());
            continue;
        }
        if (!currentPath || !line.startsWith("@@"))
            continue;
        const m = /^@@+ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!m)
            continue;
        const start = Number(m[1]);
        const count = m[2] == null ? 1 : Number(m[2]);
        if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0)
            continue;
        const set = byPath.get(currentPath);
        for (let i = 0; i < count; i++)
            set.add(start + i);
    }
    // A rename with no edits produces a header and no hunks; drop those so they
    // don't appear as files with zero new lines.
    for (const [path, lines] of byPath)
        if (lines.size === 0)
            byPath.delete(path);
    return byPath;
}
// The branch this work most likely started from.
function defaultBranchRef(git) {
    const head = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (head && head.trim())
        return head.trim();
    for (const ref of ["origin/main", "origin/master", "main", "master"]) {
        if (git(["rev-parse", "--verify", "--quiet", ref]))
            return ref;
    }
    return null;
}
// Pair each path with its absolute location.
function toFileChanges(root, byPath, all) {
    return [...byPath].map(([path, lines]) => ({
        path,
        absPath: resolvePath(root, path),
        lines,
        all,
    }));
}
// Changed lines for the project at `root`, or null when this is not a git
// repository, git is unavailable, or nothing has changed.
export function changedLines(root, options = {}) {
    const git = options.exec ?? createGitExec(root);
    if (!git(["rev-parse", "--is-inside-work-tree"]))
        return null;
    // git reports paths relative to the repository root, which isn't
    // necessarily the folder we were handed — a coverage report inside a
    // monorepo package resolves to that package, not the checkout.
    const topLevel = String(git(["rev-parse", "--show-toplevel"]) || "").trim();
    const base = topLevel ? resolvePath(topLevel) : resolvePath(root);
    const files = [];
    // Untracked files: entirely new, so every executable line is "new code".
    const untracked = git(["ls-files", "--others", "--exclude-standard"]);
    for (const raw of String(untracked || "").split(/\r?\n/)) {
        const path = normalizeSlashes(unquotePath(raw));
        if (!path)
            continue;
        const absPath = resolvePath(base, path);
        // Only production files reach patch coverage, so only they are worth
        // opening to measure.
        const lineCount = isProductionSource(path) ? countLines(absPath) : undefined;
        files.push({ path, absPath, lines: new Set(), all: true, lineCount });
    }
    // Uncommitted edits (staged and unstaged) against HEAD.
    const working = git(["diff", "--unified=0", "--no-color", "--no-ext-diff", "HEAD"]);
    const workingChanges = parseUnifiedDiff(working ?? "");
    const workingFiles = [...files, ...toFileChanges(base, workingChanges, false)];
    // Only let the working tree win when it actually contains code, so editing
    // a README beside committed work does not hide that work.
    if (workingFiles.some((f) => isProductionSource(f.path))) {
        return { root: base, against: "uncommitted changes", files: workingFiles };
    }
    // Clean tree: compare the branch against where it forked from.
    const branchBase = defaultBranchRef(git);
    if (!branchBase)
        return null;
    const mergeBase = git(["merge-base", "HEAD", branchBase]);
    const point = String(mergeBase || "").trim();
    if (!point)
        return null;
    const branchDiff = git(["diff", "--unified=0", "--no-color", "--no-ext-diff", `${point}..HEAD`]);
    const branchChanges = parseUnifiedDiff(branchDiff ?? "");
    if (!branchChanges.size)
        return null;
    return { root: base, against: `this branch vs ${branchBase}`, files: toFileChanges(base, branchChanges, false) };
}
//# sourceMappingURL=gitdiff.js.map