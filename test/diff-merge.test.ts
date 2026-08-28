// Diff mode on a merged run. Diff mode resolves a change set from ONE results
// path, and a merged run has several, so the wiring has to pick one. What is
// pinned below is that a merged run gets a change set at all, and that
// relevance is computed from the whole concatenation rather than one member.
// That the pick is harmless -- git re-resolves any path to the repository top
// level, so every source yields the same change set -- is git's behaviour and
// is NOT verified here; the fake below supplies it. These start a real server,
// because the behaviour under test is the wiring rather than any pure function:
// computeRelevance itself is covered in diff-relevance.test.ts.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createResultsServer } from "../src/server.js";
import type { GitExec } from "../src/coverage/analysis/gitdiff.js";

// classname is what relevance matches on: a change to Calc.cs is expected to be
// covered by a CalcTests, so only the second source's row should be tagged.
const junit = (className: string, name: string) => `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="${className}">
    <testcase name="${name}" classname="${className}" time="0.01" />
  </testsuite>
</testsuites>`;

const DIFF = `--- a/src/Calc.cs
+++ b/src/Calc.cs
@@ -1,2 +1,3 @@
 public class Calc {
+  public int Add(int a, int b) => a + b;
 }
`;

// A clean tree with one edited production file. --show-toplevel answers with
// `top` whatever root it is asked about, which is a stand-in for git's own
// re-resolution rather than a check of it: nothing here can fail if that
// re-resolution stops happening.
function fakeGit(top: string): GitExec {
  return (args) => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return top + "\n";
    if (args[0] === "ls-files") return "";
    if (args[0] === "diff") return DIFF;
    return "";
  };
}

// Two test projects, each with its own .csproj so findProjectRoot stops inside
// the project rather than walking on. Nested a level below the temp dir: a
// fixture sitting directly in it is reachable from every other test's parent
// walk, and node --test runs files in parallel.
function makeSolution(): { root: string; sol: string; alpha: string; calc: string } {
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "diff-merge-")));
  const sol = join(root, "sol");
  mkdirSync(join(sol, "src"), { recursive: true });
  writeFileSync(join(sol, "src", "Calc.cs"), "public class Calc {\n}\n");

  const write = (proj: string, className: string, name: string) => {
    const dir = join(sol, proj);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, proj + ".csproj"), "<Project />");
    const file = join(dir, proj + ".junit.xml");
    writeFileSync(file, junit(className, name));
    return file;
  };

  return { root, sol, alpha: write("ProjA", "AlphaTests", "alpha runs"), calc: write("ProjB", "CalcTests", "adds") };
}

// diff reaches clients only through the SSE payload -- there is no accessor for
// it on the handle -- so the assertions below read the frame the UI consumes.
async function firstFrame(url: string) {
  const abort = new AbortController();
  const res = await fetch(new URL("/events", url), { signal: abort.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const line = buffer.split("\n").find((l) => l.startsWith("data: "));
      if (line) return JSON.parse(line.slice(6));
    }
  } finally {
    abort.abort();
  }
  throw new Error("no state frame arrived");
}

test("diff mode computes on a merged run", async () => {
  // The guard for how rebuild() calls applyResults: a merged run has no single
  // results path, and passing null instead of a source leaves refreshDiff with
  // no root to resolve, which silently turns diff mode off for every merged run.
  const { root, sol, alpha, calc } = makeSolution();
  const handle = await createResultsServer({
    port: 0, watch: false, gitExec: fakeGit(sol), resultsFiles: [alpha, calc], name: "Merged",
  });
  try {
    const state = await firstFrame(handle.url);
    assert.equal(state.group?.sources.length, 2, "the fixture must really be a merged run");
    assert.ok(state.diff, "a merged run still reports a change set");
    assert.equal(state.diff.against, "uncommitted changes");
    assert.equal(state.diff.changedFiles, 1);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a merged run tags a relevant test in a source other than the first", async () => {
  // Relevance runs on the concatenation, not per source. Were it computed from
  // one member, the row it should tag here -- which lives in the second file --
  // would never be looked at.
  const { root, sol, alpha, calc } = makeSolution();
  const handle = await createResultsServer({
    port: 0, watch: false, gitExec: fakeGit(sol), resultsFiles: [alpha, calc], name: "Merged",
  });
  try {
    const state = await firstFrame(handle.url);
    assert.deepEqual(
      state.results.map((r: { source: string }) => r.source),
      ["ProjA.junit.xml", "ProjB.junit.xml"],
      "row order follows source order, so index 1 is the second file's row",
    );
    assert.equal(state.diff.counts.relevant, 1, "only the row matching Calc.cs is relevant");
    assert.ok(state.diff.tags["1"], "the tagged row is the one from the second source");
    assert.equal(state.diff.tags["1"].kind, "impacted");
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
