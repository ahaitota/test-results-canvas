// Which lines the working tree has changed, read from git. Intersected with the
// coverage hit map, this answers "did the agent test the code it just wrote?"
// (see patch.ts).
//
// Two comparisons, in order: uncommitted work against HEAD, then -- if the tree
// is clean -- this branch against its merge-base with the default branch, so the
// answer survives the agent committing. Untracked files count as entirely new.
//
// git is spawned with a fixed argument list, never a shell string, and only
// inside the resolved project root.
import { execFileSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { normalizeSlashes } from "./sources.js";
import { isProductionSource, isTestPath } from "./classify.js";
const GIT_TIMEOUT_MS = 5000;
const MAX_BUFFER = 16 * 1024 * 1024;
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
// git quotes paths containing specials as a C string: "src/a\tb.ts". Anything
// non-ASCII arrives as one octal escape per UTF-8 byte, so a single character
// spans several escapes: café.ts comes back as caf\303\251.ts. Decoding each
// escape to its own character would yield the Latin-1 reading (cafÃ©.ts), a
// path that matches nothing in the coverage report and leaves the file looking
// unmeasured. So collect bytes and decode the result as UTF-8 once.
const C_ESCAPES = { a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d };
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
function unquotePath(raw) {
    const s = raw.trim();
    if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2)
        return s;
    const body = s.slice(1, -1);
    const bytes = [];
    // Unescaped runs are buffered so surrogate pairs are encoded whole.
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
// Parse `git diff --unified=0` output into added line numbers per file.
//
// With zero context the hunk header alone carries the answer: `@@ -a,b +c,d @@`
// means d lines were added starting at c (d omitted means 1, d = 0 a deletion).
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
    // A rename with no edits produces a +++ header and no hunks; drop those so
    // they don't show as files with zero new lines.
    for (const [path, lines] of byPath)
        if (lines.size === 0)
            byPath.delete(path);
    return byPath;
}
// The branch this work most likely departed from.
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
    // git reports paths relative to the repository root, which is not
    // necessarily the directory we were handed -- a coverage report inside a
    // monorepo package resolves to that package, not the checkout.
    const topLevel = String(git(["rev-parse", "--show-toplevel"]) || "").trim();
    const base = topLevel ? resolvePath(topLevel) : resolvePath(root);
    const files = [];
    // Untracked files: entirely new, so every executable line is "new code".
    const untracked = git(["ls-files", "--others", "--exclude-standard"]);
    for (const raw of String(untracked || "").split(/\r?\n/)) {
        const path = normalizeSlashes(unquotePath(raw));
        if (path)
            files.push({ path, absPath: resolvePath(base, path), lines: new Set(), all: true });
    }
    // Uncommitted edits (staged and unstaged) against HEAD.
    const working = git(["diff", "--unified=0", "--no-color", "--no-ext-diff", "HEAD"]);
    const workingChanges = parseUnifiedDiff(working ?? "");
    const workingFiles = [...files, ...toFileChanges(base, workingChanges, false)];
    // Only let the working tree win when it actually holds code: editing a
    // README beside committed work made the New code section disappear mid-edit.
    const holdsCode = (f) => isProductionSource(f.path) || (options.includeTests === true && isTestPath(f.path));
    if (workingFiles.some(holdsCode)) {
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