// Unit tests for the "did the new code get tested?" pipeline: git diff parsing,
// the changed-lines/coverage intersection, and the ranking of what is worth
// covering. git is injected, so nothing here builds a throwaway repository.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve as resolvePath, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseUnifiedDiff, changedLines } from "../src/coverage/analysis/gitdiff.js";
import type { GitExec, FileChanges } from "../src/coverage/analysis/gitdiff.js";
import { computePatchCoverage, matchCoverageFile, toRanges } from "../src/coverage/analysis/patch.js";
import { rankUncovered } from "../src/coverage/analysis/rank.js";
import { isProductionSource, isTestPath, isGeneratedPath } from "../src/coverage/sources/classify.js";
import { buildFiles, totalsOf } from "../src/coverage/model/totals.js";
import type { CoverageReport, LineHits } from "../src/coverage/model/types.js";

function report(entries: { path: string; lines: LineHits }[]): CoverageReport {
  const files = buildFiles(entries);
  return { format: "lcov", files, totals: totalsOf(files), sourceRoots: [] };
}

function change(path: string, lines: number[], all = false): FileChanges {
  return { path, absPath: resolvePath("/repo", path), lines: new Set(lines), all };
}

// --- git diff parsing -------------------------------------------------------

test("parseUnifiedDiff reads added line numbers straight from hunk headers", () => {
  // --unified=0 means the header alone is authoritative: no counting of "+".
  const diff = [
    "diff --git a/src/calc.ts b/src/calc.ts",
    "--- a/src/calc.ts",
    "+++ b/src/calc.ts",
    "@@ -10,0 +11,3 @@",
    "+one",
    "+two",
    "+three",
    "@@ -40,2 +44 @@",
    "+merged",
  ].join("\n");
  const map = parseUnifiedDiff(diff);
  assert.deepEqual([...map.get("src/calc.ts")!].sort((a, b) => a - b), [11, 12, 13, 44]);
});

test("parseUnifiedDiff ignores deletions and drops no-op renames", () => {
  const diff = [
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,5 +0,0 @@",
    "--- a/old.ts",
    "+++ b/new.ts",
  ].join("\n");
  const map = parseUnifiedDiff(diff);
  assert.equal(map.has("gone.ts"), false, "a deleted file has no new lines");
  assert.equal(map.has("new.ts"), false, "a rename with no edits is not a change to cover");
});

test("parseUnifiedDiff unquotes paths git escaped", () => {
  const diff = ['--- "a/src/od\\td.ts"', '+++ "b/src/od\\td.ts"', "@@ -0,0 +1 @@", "+x"].join("\n");
  const map = parseUnifiedDiff(diff);
  assert.deepEqual([...map.keys()], ["src/od\td.ts"]);
});

// With core.quotePath (the default), git escapes a non-ASCII path one octal
// number per UTF-8 byte: café.ts is emitted as caf\303\251.ts. Reading each
// byte as its own character gives cafÃ©.ts, which matches no entry in the
// coverage report, so a covered file is shown as unmeasured.
test("parseUnifiedDiff decodes an octal-escaped path as UTF-8, not byte by byte", () => {
  const diff = ['--- "a/src/caf\\303\\251.ts"', '+++ "b/src/caf\\303\\251.ts"', "@@ -0,0 +1 @@", "+x"].join("\n");
  const map = parseUnifiedDiff(diff);
  assert.deepEqual([...map.keys()], ["src/café.ts"]);
});

test("parseUnifiedDiff decodes a multi-byte character outside the Latin-1 range", () => {
  // 日 is three UTF-8 bytes; an emoji is four, and a surrogate pair in JS.
  const diff = [
    '+++ "b/src/\\346\\227\\245/\\360\\237\\232\\200.ts"',
    "@@ -0,0 +1 @@",
    "+x",
  ].join("\n");
  assert.deepEqual([...parseUnifiedDiff(diff).keys()], ["src/日/🚀.ts"]);
});

test("parseUnifiedDiff unescapes a quote in a path without dropping it", () => {
  const diff = ['+++ "b/src/a\\".ts"', "@@ -0,0 +1 @@", "+x"].join("\n");
  assert.deepEqual([...parseUnifiedDiff(diff).keys()], ['src/a".ts']);
});

// An added line reading `++ value;` is rendered `+++ value;`, which is exactly
// the shape of a file header. Counting the body out of the hunk header is what
// tells them apart, so the lines after it stay with the file they belong to.
test("parseUnifiedDiff keeps an added line that looks like a file header inside its hunk", () => {
  const diff = [
    "diff --git a/src/calc.ts b/src/calc.ts",
    "--- a/src/calc.ts",
    "+++ b/src/calc.ts",
    "@@ -0,0 +1,2 @@",
    "+++ value;",
    "+run();",
    "@@ -10,0 +20 @@",
    "+later();",
  ].join("\n");
  const map = parseUnifiedDiff(diff);
  assert.deepEqual([...map.keys()], ["src/calc.ts"], "the added line must not become a file of its own");
  assert.deepEqual([...map.get("src/calc.ts")!].sort((a, b) => a - b), [1, 2, 20]);
});

test("parseUnifiedDiff recovers at the next file when a hunk body is short", () => {
  // The body count is exact for real --unified=0 output, but a truncated diff
  // must not swallow the files that follow it.
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -0,0 +1,5 @@",
    "+one",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -0,0 +1 @@",
    "+two",
  ].join("\n");
  assert.deepEqual([...parseUnifiedDiff(diff).keys()].sort(), ["src/a.ts", "src/b.ts"]);
});

test('changedLines pins the diff prefixes so a configured "after/" cannot reach the parser', () => {
  // diff.mnemonicPrefix and diff.srcPrefix/dstPrefix rewrite the header, and a
  // path spelled after/src/a.ts matches nothing in the coverage report.
  const diffArgs: string[][] = [];
  const git: GitExec = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
    if (args[0] === "rev-parse") return "/repo\n";
    if (args[0] === "ls-files") return "";
    if (args[0] === "diff") {
      diffArgs.push(args);
      return "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -0,0 +1 @@\n+n\n";
    }
    return "";
  };
  const result = changedLines("/repo", { exec: git });
  assert.deepEqual(result?.files.map((f) => f.path), ["src/x.ts"]);
  assert.ok(diffArgs.length > 0, "a diff was asked for");
  for (const args of diffArgs) {
    assert.ok(args.includes("--src-prefix=a/"), `source prefix pinned in ${args.join(" ")}`);
    assert.ok(args.includes("--dst-prefix=b/"), `destination prefix pinned in ${args.join(" ")}`);
  }
});

test("changedLines stops rather than reporting a short change set when git fails", () => {
  // A failed `diff HEAD` is not a clean tree. Reading it as one fell through to
  // the branch diff, which reports committed work only -- so the panel showed a
  // change set with every uncommitted line missing and nothing saying so.
  const git: GitExec = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
    if (args[0] === "rev-parse" && args[1] === "--verify") return args[3] === "HEAD" ? "abc123\n" : "origin/main\n";
    if (args[0] === "rev-parse") return "/repo\n";
    if (args[0] === "ls-files") return "";
    if (args[0] === "merge-base") return "deadbee\n";
    // The uncommitted diff fails; the branch diff would have answered happily.
    if (args[0] === "diff") return args.includes("HEAD") ? null : "--- a/src/old.ts\n+++ b/src/old.ts\n@@ -0,0 +1 @@\n+n\n";
    return null;
  };
  assert.equal(changedLines("/repo", { exec: git }), null);
});

test("changedLines still reports untracked work in a repository with no commits", () => {
  // There `diff HEAD` fails because HEAD does not exist yet, and the untracked
  // list is already the whole change set -- so this failure is the one that must
  // not stop the analysis.
  const calls: string[][] = [];
  const git: GitExec = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--verify") return null;
    if (args[0] === "rev-parse") return "true\n";
    if (args[0] === "ls-files") return "src/first.ts\n";
    if (args[0] === "diff") return null;
    return null;
  };
  const result = changedLines("/repo", { exec: git });
  assert.equal(result?.against, "uncommitted changes");
  assert.deepEqual(result?.files.map((f) => f.path), ["src/first.ts"]);
  assert.ok(!calls.some((c) => c[0] === "merge-base"), "and it does not go looking for a branch point");
});

test("changedLines disables diff.relative so a run from a subfolder keeps the full path", () => {
  // diff.relative makes git report src/a.ts as a.ts when it runs inside src,
  // and the coverage report spells it from the repository root. The prefixes
  // above are pinned for the same reason; this is the other half of that.
  const diffArgs: string[][] = [];
  const git: GitExec = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
    if (args[0] === "rev-parse") return "/repo\n";
    if (args[0] === "ls-files") return "";
    if (args[0] === "diff") {
      diffArgs.push(args);
      return "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -0,0 +1 @@\n+n\n";
    }
    return "";
  };
  changedLines("/repo", { exec: git });
  assert.ok(diffArgs.length > 0, "a diff was asked for");
  for (const args of diffArgs) assert.ok(args.includes("--no-relative"), `relative paths disabled in ${args.join(" ")}`);
});

test("changedLines prefers uncommitted work and marks untracked files as wholly new", () => {
  const calls: string[][] = [];
  const git: GitExec = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return "true\n";
    if (args[0] === "ls-files") return "src/brand-new.ts\n";
    if (args[0] === "diff") return "--- a/src/calc.ts\n+++ b/src/calc.ts\n@@ -1,0 +2,2 @@\n+a\n+b\n";
    return null;
  };
  const result = changedLines("/repo", { exec: git });
  assert.ok(result);
  assert.equal(result.against, "uncommitted changes");

  const brandNew = result.files.find((f) => f.path === "src/brand-new.ts")!;
  assert.equal(brandNew.all, true, "an untracked file is new in its entirety");
  const edited = result.files.find((f) => f.path === "src/calc.ts")!;
  assert.deepEqual([...edited.lines], [2, 3]);
  assert.ok(!calls.some((c) => c[0] === "merge-base"), "a dirty tree must not fall back to the branch diff");
});

test("changedLines counts the lines of an untracked file so it is not sized zero", () => {
  // An untracked file has no diff to count. Without a length it reported "0
  // changed lines" and ranked below every measured file.
  const dir = mkdtempSync(join(tmpdir(), "cov-untracked-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "brand-new.ts"), "a\nb\nc\n");
  writeFileSync(join(dir, "README.md"), "one\ntwo\n");

  const git: GitExec = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${dir}\n`;
    if (args[0] === "rev-parse") return "true\n";
    if (args[0] === "ls-files") return "src/brand-new.ts\nREADME.md\n";
    if (args[0] === "diff") return "";
    return null;
  };
  const result = changedLines(dir, { exec: git });
  assert.ok(result);

  const brandNew = result.files.find((f) => f.path === "src/brand-new.ts")!;
  assert.equal(brandNew.lineCount, 3, "a trailing newline must not add a phantom line");

  const readme = result.files.find((f) => f.path === "README.md")!;
  assert.equal(readme.lineCount, undefined, "only production source is worth counting");

  rmSync(dir, { recursive: true, force: true });
});

test("an unmeasured untracked file reports its length, not zero changed lines", () => {
  const changes = {
    against: "uncommitted changes",
    files: [{ ...change("src/brand-new.ts", [], true), lineCount: 42 }],
  };
  const patch = computePatchCoverage(report([{ path: "src/other.ts", lines: { 1: 1 } }]), changes);
  assert.ok(patch);
  assert.equal(patch.files[0].unmeasured, true);
  assert.equal(patch.files[0].changedLines, 42);
});

test("changedLines falls back to the merge-base when the tree is clean", () => {
  const git: GitExec = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
    if (args[0] === "ls-files") return "";
    if (args[0] === "diff" && args[args.length - 1] === "HEAD") return "";
    if (args[0] === "symbolic-ref") return "origin/main\n";
    if (args[0] === "merge-base") return "abc123\n";
    if (args[0] === "diff") return "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -0,0 +7 @@\n+n\n";
    return null;
  };
  const result = changedLines("/repo", { exec: git });
  assert.ok(result);
  assert.equal(result.against, "this branch vs origin/main");
  assert.deepEqual([...result.files[0].lines], [7]);
});

test("changedLines ignores a working tree holding nothing but docs and config", () => {
  // Editing a README beside committed work is routine. Treating that as the
  // change under review left New code empty even though the branch had 33
  // changed source files -- so the branch diff has to win here.
  const calls: string[][] = [];
  const git: GitExec = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
    if (args[0] === "ls-files") return "notes.txt\n";
    if (args[0] === "diff" && args[args.length - 1] === "HEAD") {
      return "--- a/README.md\n+++ b/README.md\n@@ -1,0 +2 @@\n+docs\n";
    }
    if (args[0] === "symbolic-ref") return "origin/main\n";
    if (args[0] === "merge-base") return "abc123\n";
    if (args[0] === "diff") return "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -0,0 +7 @@\n+n\n";
    return null;
  };
  const result = changedLines("/repo", { exec: git });
  assert.ok(result);
  assert.equal(result.against, "this branch vs origin/main");
  assert.deepEqual(result.files.map((f) => f.path), ["src/x.ts"]);
  assert.ok(calls.some((c) => c[0] === "merge-base"));
});

test("changedLines still prefers the working tree when one source file is in it", () => {
  // The fallback must not overreach: a single touched source file means the
  // user is mid-change, and that is the more urgent comparison.
  const git: GitExec = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
    if (args[0] === "ls-files") return "";
    if (args[0] === "diff" && args[args.length - 1] === "HEAD") {
      return "--- a/README.md\n+++ b/README.md\n@@ -1,0 +2 @@\n+docs\n"
        + "--- a/src/calc.ts\n+++ b/src/calc.ts\n@@ -1,0 +3 @@\n+code\n";
    }
    return null;
  };
  const result = changedLines("/repo", { exec: git });
  assert.ok(result);
  assert.equal(result.against, "uncommitted changes");
});

test("changedLines resolves paths against git's own top level, not the folder it was given", () => {
  // Called with a monorepo package directory, git still reports repo-relative
  // paths; resolving them against the package would fabricate paths that match
  // nothing in the coverage report.
  const git: GitExec = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${resolvePath("/repo")}\n`;
    if (args[0] === "ls-files") return "";
    if (args[0] === "diff") return "--- a/packages/app/src/x.ts\n+++ b/packages/app/src/x.ts\n@@ -0,0 +1 @@\n+n\n";
    return null;
  };
  const result = changedLines(resolvePath("/repo/packages/app"), { exec: git });
  assert.ok(result);
  assert.equal(result.root, resolvePath("/repo"));
  assert.equal(result.files[0].absPath, resolvePath("/repo/packages/app/src/x.ts"));
});

test("changedLines asks git for untracked paths relative to the repository, not the package", () => {
  // git prints untracked paths relative to the directory it ran in, so without
  // --full-name a monorepo package reports new files at a path that resolves
  // nowhere.
  const dir = mkdtempSync(join(tmpdir(), "cov-monorepo-"));
  const pkg = join(dir, "packages", "app");
  mkdirSync(join(pkg, "src"), { recursive: true });
  writeFileSync(join(pkg, "src", "new.ts"), "a\nb\n");

  const git: GitExec = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${dir}\n`;
    if (args[0] === "rev-parse") return "true\n";
    if (args[0] === "ls-files") return args.includes("--full-name") ? "packages/app/src/new.ts\n" : "src/new.ts\n";
    if (args[0] === "diff") return "";
    return null;
  };
  const result = changedLines(pkg, { exec: git });
  assert.ok(result);

  const added = result.files[0];
  assert.equal(added.path, "packages/app/src/new.ts");
  assert.equal(added.absPath, join(pkg, "src", "new.ts"));
  assert.equal(added.lineCount, 2, "a path that resolves is a file that can be sized");

  rmSync(dir, { recursive: true, force: true });
});

test("changedLines degrades to null outside a repository rather than throwing", () => {
  assert.equal(changedLines("/repo", { exec: () => null }), null);
});

// --- patch coverage ---------------------------------------------------------

test("computePatchCoverage counts only the lines that changed", () => {
  // The file is 50% covered overall, but every *changed* line ran -- which is
  // the distinction the whole feature rests on.
  const rep = report([{ path: "src/calc.ts", lines: { 1: 0, 2: 0, 10: 3, 11: 4 } }]);
  const patch = computePatchCoverage(rep, { against: "uncommitted changes", files: [change("src/calc.ts", [10, 11])] });
  assert.ok(patch);
  assert.equal(patch.total, 2);
  assert.equal(patch.covered, 2);
  assert.equal(patch.percent, 100);
  assert.deepEqual(patch.files[0].uncoveredLines, []);
});

test("computePatchCoverage surfaces new lines that no test reached", () => {
  const rep = report([{ path: "src/calc.ts", lines: { 10: 1, 11: 0, 12: 0 } }]);
  const patch = computePatchCoverage(rep, { against: "uncommitted changes", files: [change("src/calc.ts", [10, 11, 12])] });
  assert.ok(patch);
  assert.equal(patch.percent, 33);
  assert.deepEqual(patch.files[0].uncoveredLines, [11, 12]);
});

test("a brand-new file counts every executable line as new", () => {
  const rep = report([{ path: "src/brand-new.ts", lines: { 1: 0, 2: 0, 3: 1 } }]);
  const patch = computePatchCoverage(rep, {
    against: "uncommitted changes",
    files: [change("src/brand-new.ts", [], true)],
  });
  assert.ok(patch);
  assert.equal(patch.total, 3);
  assert.deepEqual(patch.files[0].uncoveredLines, [1, 2]);
});

test("a changed production file absent from the report is reported as unmeasured", () => {
  // This is the agent-wrote-a-file-and-no-test-touched-it case, and it is the
  // single most useful thing the panel can say.
  const patch = computePatchCoverage(report([{ path: "src/other.ts", lines: { 1: 1 } }]), {
    against: "uncommitted changes",
    files: [change("src/untested.ts", [1, 2, 3])],
  });
  assert.ok(patch);
  assert.equal(patch.unmeasuredFiles, 1);
  assert.equal(patch.files[0].unmeasured, true);
  assert.equal(patch.files[0].path, "src/untested.ts");
});

test("changed docs and test files do not distort patch coverage", () => {
  const patch = computePatchCoverage(report([{ path: "src/calc.ts", lines: { 1: 1 } }]), {
    against: "uncommitted changes",
    files: [change("README.md", [1]), change("test/calc.test.ts", [1, 2]), change("src/calc.ts", [1])],
  });
  assert.ok(patch);
  assert.equal(patch.files.length, 1);
  assert.equal(patch.files[0].path, "src/calc.ts");
});

test("matchCoverageFile keeps two files whose paths differ only in case apart", () => {
  // A case-insensitive comparison hands src/foo.ts the coverage of src/Foo.ts.
  // The filesystem here says they are two files, so the spelling is the answer.
  const files = report([
    { path: "src/Foo.ts", lines: { 1: 0 } },
    { path: "src/foo.ts", lines: { 1: 1 } },
  ]).files;
  assert.equal(matchCoverageFile(change("src/foo.ts", [1]), files)?.lines[1], 1);
  assert.equal(matchCoverageFile(change("src/Foo.ts", [1]), files)?.lines[1], 0);
});

test("matchCoverageFile still ignores case when only one file can be meant", () => {
  // Windows and macOS reports routinely disagree with git about case, and with
  // a single candidate there is nothing to confuse it with.
  const files = report([{ path: "src/Calc.ts", lines: { 1: 1 } }]).files;
  assert.equal(matchCoverageFile(change("src/calc.ts", [1]), files)?.path, "src/Calc.ts");
});

test("one report entry claimed by two changed files measures neither", () => {
  // A report that shortened its paths to src/index.ts ends both of these. Taken
  // per change it is a clean match each time, so the same coverage would be
  // reported twice -- once truthfully and once not, with no way to tell which.
  const patch = computePatchCoverage(report([{ path: "src/index.ts", lines: { 1: 1, 2: 1 } }]), {
    against: "HEAD",
    files: [change("packages/a/src/index.ts", [1, 2]), change("packages/b/src/index.ts", [1, 2])],
  });
  assert.ok(patch);
  assert.equal(patch.unmeasuredFiles, 2);
  assert.equal(patch.total, 0);
  assert.deepEqual(patch.files.map((f) => f.unmeasured), [true, true]);
});

test("a changed line the report never mentions is counted apart, not dropped", () => {
  const patch = computePatchCoverage(report([{ path: "src/calc.ts", lines: { 1: 1 } }]), {
    against: "uncommitted changes",
    files: [change("src/calc.ts", [99])],
  });
  assert.ok(patch);
  assert.equal(patch.unknownLines, 1);
  assert.equal(patch.files.length, 1);
  assert.equal(patch.files[0].unknownLines, 1);
  assert.equal(patch.files[0].unmeasured, false);
  assert.deepEqual(patch.files[0].uncoveredLines, []);
  assert.deepEqual(patch.files[0].coveredLines, []);
});

test("a stale report cannot report 100% on lines it has never seen", () => {
  // The report predates the edit: it knows line 1 and nothing about line 2.
  // Counting only what it knows reads as a clean sweep of the change.
  const patch = computePatchCoverage(report([{ path: "src/calc.ts", lines: { 1: 1 } }]), {
    against: "HEAD",
    files: [change("src/calc.ts", [1, 2])],
  });
  assert.ok(patch);
  assert.equal(patch.covered, 1);
  assert.equal(patch.total, 1);
  assert.equal(patch.unknownLines, 1);
});

test("a changed comment is not a line the report failed to measure", () => {
  // Reports call comments coverable, and the source is consulted to drop them.
  // Counting them here would put a reformatted comment block back in front of
  // the reader under a heading about untested code.
  const rep = report([{ path: "src/calc.ts", lines: { 1: 1 } }]);
  const abs = resolvePath("/repo", "src/calc.ts");
  rep.files[0].absPath = abs;
  const patch = computePatchCoverage(
    rep,
    { against: "HEAD", files: [change("src/calc.ts", [1, 8, 9])] },
    { inertLines: new Map([[abs, new Set([8])]]) },
  );
  assert.ok(patch);
  // Line 8 is a comment; line 9 is real code the report says nothing about.
  assert.equal(patch.unknownLines, 1);
  assert.equal(patch.files[0].unknownLines, 1);
});

test("a brand-new file counts no unknown lines when its length is unknown", () => {
  // Without a line count there is nothing to compare the report against, so the
  // whole-file case claims nothing.
  const patch = computePatchCoverage(report([{ path: "src/new.ts", lines: { 2: 1, 4: 0 } }]), {
    against: "HEAD",
    files: [change("src/new.ts", [], true)],
  });
  assert.ok(patch);
  assert.equal(patch.unknownLines, 0);
  assert.deepEqual(patch.files[0].coveredLines, [2]);
  assert.deepEqual(patch.files[0].uncoveredLines, [4]);
});

test("a stale report of an untracked file that grew counts the lines it never saw", () => {
  // The report was taken while the file was one line long. Line 2 arrived after
  // it, so calling the file 100% covered would hide brand-new untested code.
  const rep = report([{ path: "src/new.ts", lines: { 1: 1 } }]);
  const abs = resolvePath("/repo", "src/new.ts");
  rep.files[0].absPath = abs;
  const patch = computePatchCoverage(
    rep,
    { against: "HEAD", files: [{ ...change("src/new.ts", [], true), lineCount: 2 }] },
    { inertLines: new Map([[abs, new Set<number>()]]) },
  );
  assert.ok(patch);
  assert.equal(patch.files[0].unknownLines, 1);
  assert.equal(patch.unknownLines, 1);
  // The measured line really is covered; the gap sits outside the percentage.
  assert.equal(patch.percent, 100);
});

test("a whole-file change does not count a comment tail as unmeasured code", () => {
  const rep = report([{ path: "src/new.ts", lines: { 1: 1 } }]);
  const abs = resolvePath("/repo", "src/new.ts");
  rep.files[0].absPath = abs;
  const patch = computePatchCoverage(
    rep,
    { against: "HEAD", files: [{ ...change("src/new.ts", [], true), lineCount: 4 }] },
    { inertLines: new Map([[abs, new Set([2, 3, 4])]]) },
  );
  assert.ok(patch);
  assert.equal(patch.unknownLines, 0);
});

test("a whole-file change claims nothing when the source was never scanned", () => {
  // No inert set means the source could not be read, so which of the trailing
  // lines could run is unknowable -- and guessing flags every closing brace.
  const patch = computePatchCoverage(report([{ path: "src/new.ts", lines: { 1: 1 } }]), {
    against: "HEAD",
    files: [{ ...change("src/new.ts", [], true), lineCount: 90 }],
  });
  assert.ok(patch);
  assert.equal(patch.unknownLines, 0);
});

test("a whole-file change counts nothing when the report reaches past the file's end", () => {
  // A report older than a file that shrank mentions lines that no longer exist.
  const rep = report([{ path: "src/new.ts", lines: { 1: 1, 9: 0 } }]);
  const abs = resolvePath("/repo", "src/new.ts");
  rep.files[0].absPath = abs;
  const patch = computePatchCoverage(
    rep,
    { against: "HEAD", files: [{ ...change("src/new.ts", [], true), lineCount: 3 }] },
    { inertLines: new Map([[abs, new Set<number>()]]) },
  );
  assert.ok(patch);
  assert.equal(patch.unknownLines, 0);
});

test("computePatchCoverage returns null when there is no diff at all", () => {
  assert.equal(computePatchCoverage(report([{ path: "a.ts", lines: { 1: 1 } }]), null), null);
});

test("matchCoverageFile pairs a repo-relative diff path with an absolute report path", () => {
  // LCOV written on CI carries the runner's absolute paths; git speaks
  // repo-relative. Matching on trailing segments is what lines them up.
  const files = report([
    { path: "/home/runner/work/repo/src/app/calc.ts", lines: { 1: 1 } },
    { path: "/home/runner/work/repo/src/other/calc.ts", lines: { 1: 1 } },
  ]).files;
  const matched = matchCoverageFile(change("src/app/calc.ts", [1]), files);
  assert.equal(matched?.path, "/home/runner/work/repo/src/app/calc.ts");
});

test("matchCoverageFile refuses a match on filename alone", () => {
  const files = report([{ path: "vendor/lib/calc.ts", lines: { 1: 1 } }]).files;
  assert.equal(matchCoverageFile(change("src/calc.ts", [1]), files), undefined);
});

test("matchCoverageFile refuses a sibling package that merely shares trailing folders", () => {
  // packages/a/src/index.ts and packages/b/src/index.ts share three trailing
  // segments, so any "enough segments in common" rule pairs them and reports
  // package b's coverage as package a's.
  const files = report([{ path: "packages/b/src/index.ts", lines: { 1: 1, 2: 1 } }]).files;
  const patch = computePatchCoverage(report([{ path: "packages/b/src/index.ts", lines: { 1: 1, 2: 1 } }]), {
    against: "HEAD",
    files: [change("packages/a/src/index.ts", [1, 2])],
  });
  assert.equal(matchCoverageFile(change("packages/a/src/index.ts", [1, 2]), files), undefined);
  assert.deepEqual(patch?.files.map((f) => [f.path, f.unmeasured]), [["packages/a/src/index.ts", true]]);
});

test("matchCoverageFile refuses an entry resolved to another package", () => {
  // The report shortened its path to src/index.ts, which is the tail of every
  // package's copy. Resolving it found package b, so pairing it with a change
  // in package a would report b's hit counts against a's line numbers.
  const files = report([{ path: "src/index.ts", lines: { 1: 1, 2: 1 } }]).files;
  files[0].absPath = resolvePath("/repo", "packages/b/src/index.ts");
  assert.equal(matchCoverageFile(change("packages/a/src/index.ts", [1, 2]), files), undefined);
});

test("matchCoverageFile still pairs one file reached through two roots", () => {
  // A symlinked checkout resolves the report through /private/var and git
  // through /var. One path holding the whole of the other is that file twice,
  // not two files, so identity must not reject it.
  const files = report([{ path: "src/calc.ts", lines: { 1: 1 } }]).files;
  files[0].absPath = "/private/var/repo/src/calc.ts";
  const matched = matchCoverageFile(
    { path: "src/calc.ts", absPath: "/var/repo/src/calc.ts", lines: new Set([1]), all: false },
    files,
  );
  assert.equal(matched?.path, "src/calc.ts");
});

test("toRanges collapses runs and bridges a single-line gap", () => {
  // The gap tolerance keeps a closing brace between two uncovered statements

  // from splitting one region into two.
  assert.deepEqual(toRanges([3, 4, 5]), [{ start: 3, end: 5 }]);
  assert.deepEqual(toRanges([3, 5]), [{ start: 3, end: 5 }]);
  assert.deepEqual(toRanges([3, 9]), [{ start: 3, end: 3 }, { start: 9, end: 9 }]);
  assert.deepEqual(toRanges([]), []);
});

// --- classification and ranking ---------------------------------------------

test("classify separates production code from tests and generated output", () => {
  assert.equal(isProductionSource("src/app/calc.ts"), true);
  assert.equal(isProductionSource("README.md"), false);
  assert.equal(isTestPath("test/calc.test.ts"), true);
  assert.equal(isTestPath("src/App.Tests/CalcTests.cs"), true);
  // A conventional .NET test project: the folder is what marks it, since not
  // every file inside is named like a test.
  assert.equal(isProductionSource("src/MyApp.Tests/Usings.cs"), false);
  assert.equal(isProductionSource("src/MyApp.Spec/Fixtures.cs"), false);
  // A folder that merely contains the word is still production code.
  assert.equal(isProductionSource("src/Contest/Entry.cs"), true);
  assert.equal(isProductionSource("test/calc.test.ts"), false);
  assert.equal(isGeneratedPath("obj/Form1.Designer.cs"), true);
  assert.equal(isGeneratedPath("dist/app.min.js"), true);
  assert.equal(isProductionSource("obj/Form1.Designer.cs"), false);
});

test("classify needs a name boundary before calling a file a test", () => {
  // "test" ending a word is not a test suffix. Reading contest.ts as one drops
  // it out of production totals, patch coverage and the hotspot list at once.
  assert.equal(isTestPath("src/contest.ts"), false);
  assert.equal(isTestPath("src/latest.ts"), false);
  assert.equal(isTestPath("src/attest.py"), false);
  assert.equal(isTestPath("src/manifest.ts"), false);
  assert.equal(isProductionSource("src/contest.ts"), true);
  // The forms the boundary has to keep: PascalCase, an all-caps prefix, a bare
  // name, and the separator spellings TEST_FILE_RE owns.
  assert.equal(isTestPath("src/CalculatorTests.cs"), true);
  assert.equal(isTestPath("src/HTTPTests.cs"), true);
  assert.equal(isTestPath("src/AccountSpec.java"), true);
  assert.equal(isTestPath("src/Tests.cs"), true);
  assert.equal(isTestPath("src/tests.py"), true);
  assert.equal(isTestPath("src/calc_test.go"), true);
  assert.equal(isTestPath("src/Calc.Tests.cs"), true);
});

test("classify reads a qualified .NET test project as tests, whatever qualifies it", () => {
  // TEST_DIR_RE only matches App.Tests. The convention of naming the kind of
  // test -- UnitTests, IntegrationTests -- is just as common, and those projects
  // were counted as production: fully covered by definition, so they lifted the
  // headline and pushed the shipping code down the ranking.
  assert.equal(isTestPath("src/App.UnitTests/Usings.cs"), true);
  assert.equal(isTestPath("src/App.IntegrationTests/Fixture.cs"), true);
  assert.equal(isTestPath("App.FunctionalTests/Setup.cs"), true);
  assert.equal(isTestPath("src/App.ApiSpecs/Given.cs"), true);
  // The same boundary rule as above: a qualifier that merely ends in the word
  // is not one. Lower case is what separates them, so it has to stay.
  assert.equal(isTestPath("src/Contoso.Protests/Entry.cs"), false);
  assert.equal(isTestPath("src/Data.Contests/Entry.cs"), false);
  assert.equal(isProductionSource("src/Contoso.Protests/Entry.cs"), true);
});

test("classify treats committed build output as generated, but not source that merely reads like it", () => {
  // This repo commits dist/, so a changed src file would otherwise be counted

  // twice -- once as source, once as its compiled copy.
  assert.equal(isGeneratedPath("dist/src/server.js"), true);
  assert.equal(isGeneratedPath("dist/src/server.d.ts"), true);
  assert.equal(isGeneratedPath("src/types.d.ts"), true);
  assert.equal(isGeneratedPath("target/classes/Calc.java"), true);
  assert.equal(isGeneratedPath("vendor/pkg/lib.go"), true);
  assert.equal(isGeneratedPath("build/out.js"), true);
  assert.equal(isProductionSource("dist/src/server.js"), false);

  // ...and the false positives that would hide real code, including this
  // extension's own src/coverage/.
  assert.equal(isGeneratedPath("src/coverage/rank.ts"), false);
  assert.equal(isGeneratedPath("coverage-sample/src/Calc.cs"), false);
  assert.equal(isGeneratedPath("src/build/pipeline.ts"), false);
  assert.equal(isGeneratedPath("src/distance.ts"), false);
  assert.equal(isProductionSource("src/coverage/rank.ts"), true);
  // Dart is a JaCoCo/LCOV-emitting ecosystem, so its source has to count.
  assert.equal(isProductionSource("lib/main.dart"), true);
  assert.equal(isProductionSource("lib/model.freezed.dart"), false);
});

test("rankUncovered puts a changed file ahead of a bigger untouched gap", () => {
  const rep = report([
    { path: "src/quiet.ts", lines: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i + 1, 0])) },
    { path: "src/edited.ts", lines: { 1: 1, 5: 0, 6: 0 } },
  ]);
  const ranked = rankUncovered(rep, { changedPaths: [{ path: "src/edited.ts" }] });
  assert.equal(ranked[0].path, "src/edited.ts", "recency of change outranks raw size");
  assert.equal(ranked[0].changed, true);
});

test("rankUncovered does not treat a sibling package's file as changed", () => {
  // Same trap as matchCoverageFile: packages/b/src/index.ts shares its trailing
  // folders with the changed packages/a/src/index.ts without being it, and a
  // false "changed" carries a 4x weight straight to the top of the list.
  const rep = report([
    { path: "packages/b/src/index.ts", lines: { 1: 0, 2: 0 } },
    { path: "packages/a/src/index.ts", lines: { 9: 0 } },
  ]);
  const ranked = rankUncovered(rep, { changedPaths: [{ path: "packages/a/src/index.ts" }] });
  const changed = Object.fromEntries(ranked.map((r) => [r.path, r.changed]));
  assert.equal(changed["packages/a/src/index.ts"], true);
  assert.equal(changed["packages/b/src/index.ts"], false);
});

test("rankUncovered still counts a shortened report path as changed", () => {
  // src/index.ts is one of the two changed files -- we just cannot say which.
  // Unlike patch coverage, which would attribute the wrong line numbers, the
  // question here is only "did this change?", and the answer is yes.
  const rep = report([{ path: "src/index.ts", lines: { 1: 0, 2: 0 } }]);
  const ranked = rankUncovered(rep, { changedPaths: [{ path: "packages/a/src/index.ts" }, { path: "packages/b/src/index.ts" }] });
  assert.equal(ranked[0].changed, true);
});

test("rankUncovered does not rank a resolved sibling as changed", () => {
  // The report shortened its path to src/index.ts, but resolving it found the
  // copy in package b. That resolution outranks the shortened spelling, so a
  // change in package a must not carry package b to the top of the list.
  const rep = report([{ path: "src/index.ts", lines: { 1: 0, 2: 0 } }]);
  rep.files[0].absPath = resolvePath("/repo", "packages/b/src/index.ts");
  const ranked = rankUncovered(rep, {
    changedPaths: [{ path: "packages/a/src/index.ts", absPath: resolvePath("/repo", "packages/a/src/index.ts") }],
  });
  assert.equal(ranked[0].changed, false);
});

test("rankUncovered keeps case-distinct files apart", () => {
  const rep = report([
    { path: "src/Calc.ts", lines: { 1: 0, 2: 0 } },
    { path: "src/calc.ts", lines: { 1: 0, 2: 0 } },
  ]);
  const ranked = rankUncovered(rep, { changedPaths: [{ path: "src/calc.ts" }] });
  const changed = Object.fromEntries(ranked.map((r) => [r.path, r.changed]));
  assert.equal(changed["src/calc.ts"], true);
  assert.equal(changed["src/Calc.ts"], false);
});

test("rankUncovered ignores tests and generated files", () => {
  const rep = report([
    { path: "test/calc.test.ts", lines: { 1: 0, 2: 0, 3: 0 } },
    { path: "obj/Form1.Designer.cs", lines: { 1: 0, 2: 0, 3: 0 } },
    { path: "src/real.ts", lines: { 1: 0 } },
  ]);
  const ranked = rankUncovered(rep, { changedPaths: [] });
  assert.deepEqual(ranked.map((r) => r.path), ["src/real.ts"]);
});

test("rankUncovered flags a file no test reaches at all", () => {
  const rep = report([{ path: "src/dead.ts", lines: { 1: 0, 2: 0, 3: 0 } }]);
  const ranked = rankUncovered(rep, { changedPaths: [] });
  assert.equal(ranked[0].wholeFileUncovered, true);
  assert.equal(ranked[0].lines, 3);
  assert.equal(ranked[0].start, 1);
  assert.equal(ranked[0].end, 3);
});

test("rankUncovered returns nothing when everything is covered", () => {
  assert.deepEqual(rankUncovered(report([{ path: "src/a.ts", lines: { 1: 1, 2: 2 } }]), { changedPaths: [] }), []);
});

test("rankUncovered caps its output so the panel stays readable", () => {
  const entries = Array.from({ length: 80 }, (_, i) => ({ path: `src/f${i}.ts`, lines: { 1: 0 } }));
  assert.ok(rankUncovered(report(entries), { changedPaths: [] }).length <= 25);
});

// Counting each range by filtering the file's whole uncovered list is quadratic,
// and a file fragmented into tens of thousands of gaps -- every other line
// uncovered -- froze the panel for seconds while producing the same 25 rows.
test("rankUncovered stays quick on a file fragmented into thousands of gaps", () => {
  const lines: Record<number, number> = {};
  for (let i = 1; i <= 240_000; i++) lines[i] = i % 4 === 1 ? 0 : 1;
  const started = Date.now();
  const ranked = rankUncovered(report([{ path: "src/big.ts", lines }]), { changedPaths: [] });
  const elapsed = Date.now() - started;
  assert.equal(ranked.length, 25);
  assert.equal(ranked[0]!.lines, 1, "each gap is a single line, so each region counts one");
  assert.ok(elapsed < 2000, `ranking took ${elapsed}ms`);
});
