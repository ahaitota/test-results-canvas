// Server-level coverage tests: how coverage state follows the results file it
// belongs to. These start a real server on an ephemeral port, because the
// behaviour under test lives in the wiring, not in any one pure function.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createResultsServer } from "../src/server.js";

const TRX = `<?xml version="1.0" encoding="utf-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results><UnitTestResult testName="adds" outcome="Passed" duration="00:00:00.01" /></Results>
</TestRun>`;

const COBERTURA = `<?xml version="1.0"?>
<coverage line-rate="0.5">
  <sources><source>SRC</source></sources>
  <packages><package name="p"><classes>
    <class name="Calc" filename="src/calc.ts"><lines>
      <line number="1" hits="1" /><line number="2" hits="0" />
    </lines></class>
  </classes></package></packages>
</coverage>`;

// Two runs: one with a coverage report sitting beside it, one with none
// anywhere discovery can reach.
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cov-server-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "calc.ts"), "export const a = 1;\nexport const b = 2;\n");

  mkdirSync(join(root, "with", "run"), { recursive: true });
  writeFileSync(join(root, "with", "run", "run.trx"), TRX);
  writeFileSync(join(root, "with", "run", "coverage.cobertura.xml"), COBERTURA.replace("SRC", root));

  mkdirSync(join(root, "without", "run"), { recursive: true });
  writeFileSync(join(root, "without", "run", "run.trx"), TRX);
  return root;
}

test("switching to a run without coverage clears the previous run's coverage", async () => {
  const root = makeFixture();
  const handle = await createResultsServer({
    port: 0,
    watch: false,
    // Scoped to the half of the fixture holding no report, so discovery has
    // nowhere to legitimately find one from the second run.
    projectRoot: join(root, "without"),
    gitExec: null,
    resultsFile: join(root, "with", "run", "run.trx"),
  });
  try {
    assert.ok(handle.getCoverage(), "the adjacent report must be discovered");

    handle.loadInput({ resultsFile: join(root, "without", "run", "run.trx") });
    assert.equal(handle.getCoverage(), null, "a run with no report must not show the previous one");
    assert.equal(handle.coveragePath(), null);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a report the agent named survives a reload that discovery would miss", async () => {
  const root = makeFixture();
  const explicit = join(root, "with", "run", "coverage.cobertura.xml");
  const handle = await createResultsServer({
    port: 0,
    watch: false,
    projectRoot: join(root, "without"),
    gitExec: null,
    resultsFile: join(root, "without", "run", "run.trx"),
    coverageFile: explicit,
  });
  try {
    assert.equal(handle.coveragePath(), explicit);

    // Re-seeding without naming the report again must not lose it: the agent
    // said where coverage lives, and discovery would find nothing here.
    handle.loadInput({ resultsFile: join(root, "without", "run", "run.trx") });
    assert.equal(handle.coveragePath(), explicit);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
