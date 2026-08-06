// Which lines the working tree has changed, read from git.
//
// This is what makes "did the agent test the code it just wrote?" answerable:
// intersect these line numbers with the coverage hit map and you get patch
// coverage (see patch.ts).
//
// Two comparisons, in order:
//   1. uncommitted work against HEAD -- the usual case while an agent is editing
//   2. if the tree is clean, this branch against its merge-base with the default
//      branch, so the answer survives the agent committing its work
// Untracked files are included too and count as entirely new, since a brand-new
// source file is exactly the case this feature exists for.
//
// git is spawned with a fixed argument list (never a shell string) and only ever
// inside the resolved project root. Its absence, or the directory not being a
// repository, is not an error: the caller simply gets no "new code" section.

import { execFileSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { normalizeSlashes } from "./sources.js";

// Injected so the unit tests can drive the parser with canned git output
// instead of building throwaway repositories.
export type GitExec = (args: string[]) => string | null;

const GIT_TIMEOUT_MS = 5000;
const MAX_BUFFER = 16 * 1024 * 1024;

export function createGitExec(root: string): GitExec {
    return (args: string[]) => {
        try {
            return execFileSync("git", ["-C", root, ...args], {
                encoding: "utf8",
                timeout: GIT_TIMEOUT_MS,
                maxBuffer: MAX_BUFFER,
                windowsHide: true,
                stdio: ["ignore", "pipe", "ignore"],
            });
        } catch {
            return null;
        }
    };
}

export interface FileChanges {
    // Repo-relative, forward-slashed, as git reports it.
    path: string;
    absPath: string;
    // Added/modified line numbers in the new version of the file.
    lines: Set<number>;
    // A brand-new (or untracked) file: every executable line counts as new,
    // which spares us reading the file just to enumerate its lines.
    all: boolean;
}

export interface DiffResult {
    root: string;
    // Human-readable description of what was compared, shown in the UI so the
    // percentage is never ambiguous.
    against: string;
    files: FileChanges[];
}

// git quotes paths containing specials as a C string: "src/a\tb.ts".
function unquotePath(raw: string): string {
    const s = raw.trim();
    if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
    const body = s.slice(1, -1);
    let out = "";
    for (let i = 0; i < body.length; i++) {
        if (body[i] !== "\\") {
            out += body[i];
            continue;
        }
        const next = body[++i];
        if (next === "n") out += "\n";
        else if (next === "t") out += "\t";
        else if (next === "r") out += "\r";
        else if (next >= "0" && next <= "7") {
            // Octal escape for a non-ASCII byte.
            const octal = body.slice(i, i + 3);
            out += String.fromCharCode(parseInt(octal, 8));
            i += 2;
        } else out += next;
    }
    return out;
}

// Parse `git diff --unified=0` output into added line numbers per file.
//
// With zero context every "+" line inside a hunk is a genuine addition, so the
// hunk header alone carries the answer: `@@ -a,b +c,d @@` means d lines were
// added starting at c (d omitted means 1, d = 0 means a pure deletion).
export function parseUnifiedDiff(diff: string): Map<string, Set<number>> {
    const byPath = new Map<string, Set<number>>();
    let currentPath: string | null = null;

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
            if (!byPath.has(currentPath)) byPath.set(currentPath, new Set());
            continue;
        }
        if (!currentPath || !line.startsWith("@@")) continue;

        const m = /^@@+ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!m) continue;
        const start = Number(m[1]);
        const count = m[2] == null ? 1 : Number(m[2]);
        if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) continue;
        const set = byPath.get(currentPath)!;
        for (let i = 0; i < count; i++) set.add(start + i);
    }

    // A rename with no edits produces a +++ header and no hunks; drop those so
    // they don't show as files with zero new lines.
    for (const [path, lines] of byPath) if (lines.size === 0) byPath.delete(path);
    return byPath;
}

// The branch this work most likely departed from.
function defaultBranchRef(git: GitExec): string | null {
    const head = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (head && head.trim()) return head.trim();
    for (const ref of ["origin/main", "origin/master", "main", "master"]) {
        if (git(["rev-parse", "--verify", "--quiet", ref])) return ref;
    }
    return null;
}

function toFileChanges(root: string, byPath: Map<string, Set<number>>, all: boolean): FileChanges[] {
    return [...byPath].map(([path, lines]) => ({
        path,
        absPath: resolvePath(root, path),
        lines,
        all,
    }));
}

export interface DiffOptions {
    // Override for tests; defaults to a real git in `root`.
    exec?: GitExec;
}

// Changed lines for the project at `root`, or null when this is not a git
// repository, git is unavailable, or nothing has changed.
export function changedLines(root: string, options: DiffOptions = {}): DiffResult | null {
    const git = options.exec ?? createGitExec(root);
    if (!git(["rev-parse", "--is-inside-work-tree"])) return null;

    // git reports paths relative to the repository root, which is not
    // necessarily the directory we were handed -- a coverage report inside a
    // monorepo package resolves to that package, not the checkout. Resolving
    // against git's own top level keeps the absolute paths honest either way.
    const topLevel = String(git(["rev-parse", "--show-toplevel"]) || "").trim();
    const base = topLevel ? resolvePath(topLevel) : resolvePath(root);

    const files: FileChanges[] = [];

    // Untracked files: entirely new, so every executable line is "new code".
    const untracked = git(["ls-files", "--others", "--exclude-standard"]);
    for (const raw of String(untracked || "").split(/\r?\n/)) {
        const path = normalizeSlashes(unquotePath(raw));
        if (path) files.push({ path, absPath: resolvePath(base, path), lines: new Set(), all: true });
    }

    // Uncommitted edits (staged and unstaged) against HEAD.
    const working = git(["diff", "--unified=0", "--no-color", "--no-ext-diff", "HEAD"]);
    const workingChanges = parseUnifiedDiff(working ?? "");
    if (workingChanges.size || files.length) {
        files.push(...toFileChanges(base, workingChanges, false));
        return { root: base, against: "uncommitted changes", files };
    }

    // Clean tree: compare the branch against where it forked from.
    const branchBase = defaultBranchRef(git);
    if (!branchBase) return null;
    const mergeBase = git(["merge-base", "HEAD", branchBase]);
    const point = String(mergeBase || "").trim();
    if (!point) return null;
    const branchDiff = git(["diff", "--unified=0", "--no-color", "--no-ext-diff", `${point}..HEAD`]);
    const branchChanges = parseUnifiedDiff(branchDiff ?? "");
    if (!branchChanges.size) return null;
    return { root: base, against: `this branch vs ${branchBase}`, files: toFileChanges(base, branchChanges, false) };
}
