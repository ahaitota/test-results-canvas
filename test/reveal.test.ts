// The /reveal channel hands a local path to the desktop shell, so what it will
// act on -- and what it refuses -- matters more than the launch itself. The
// launcher is injected throughout: nothing here opens a real window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { tmpdir } from "node:os";
import { createResultsServer } from "../src/server.js";
import { launchFor, commonParent } from "../src/reveal.js";
import type { Launch } from "../src/reveal.js";

const TRX = `<?xml version="1.0" encoding="utf-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results><UnitTestResult testName="adds" outcome="Passed" duration="00:00:00.01" /></Results>
</TestRun>`;

// A name that would need quoting if it were ever pasted into a shell line.
const REPORT = "my results & more.trx";

function write(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, TRX);
  return path;
}

// A server over a real report file, with the launcher recording instead of running.
async function withServer(run: (ctx: {
  url: string;
  token: string;
  path: string;
  launches: Launch[];
  reveal: (token: string | undefined, body: unknown) => Promise<Response>;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "reveal-"));
  const path = write(join(root, REPORT));
  const launches: Launch[] = [];
  const handle = await createResultsServer({
    port: 0,
    watch: false,
    coverage: false,
    resultsFile: path,
    launch: (l) => { launches.push(l); },
  });
  try {
    const reveal = (token: string | undefined, body: unknown) => fetch(new URL("/reveal", handle.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
    await run({ url: handle.url, token: handle.askToken, path, launches, reveal });
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("each platform gets its own reveal and open commands", () => {
  const file = { kind: "file", path: "/tmp/runs/report.xml" } as const;
  assert.deepEqual(launchFor("reveal", file, "win32"), { command: "explorer.exe", args: [`/select,"${file.path}"`], verbatim: true });
  // Not explorer.exe: handed a file it has no handler for, that opens nothing
  // and says nothing. The shell's own opener at least offers "Open with".
  assert.deepEqual(launchFor("open", file, "win32"), { command: "rundll32.exe", args: ["shell32.dll,ShellExec_RunDLL", file.path] });
  assert.deepEqual(launchFor("reveal", file, "darwin"), { command: "open", args: ["-R", file.path] });
  assert.deepEqual(launchFor("open", file, "darwin"), { command: "open", args: [file.path] });
  // Linux has no portable "select this file", so revealing opens the folder.
  assert.deepEqual(launchFor("reveal", file, "linux"), { command: "xdg-open", args: [dirname(file.path)] });
  assert.deepEqual(launchFor("open", file, "linux"), { command: "xdg-open", args: [file.path] });
  assert.equal(launchFor("open", file, "aix"), null);
});

// Explorer reads the comma as a field separator only outside quotes, and argv
// quoting would put a space after it, which selects nothing -- measured: the
// window does not even open.
test("a Windows reveal keeps /select, against the quoted path", () => {
  const path = "C:\\Test Results\\run.trx";
  const launch = launchFor("reveal", { kind: "file", path }, "win32")!;
  assert.deepEqual(launch.args, [`/select,"${path}"`]);
  assert.equal(launch.verbatim, true, "a raw command line is the only way to spell it");
});

// A folder is where the run is; there is nothing inside it to single out.
test("a folder target opens itself whichever action was asked for", () => {
  const dir = { kind: "dir", path: "/tmp/runs" } as const;
  for (const platform of ["win32", "darwin", "linux"] as NodeJS.Platform[]) {
    const reveal = launchFor("reveal", dir, platform)!;
    assert.deepEqual(reveal.args, [dir.path], `${platform} reveal`);
    assert.deepEqual(launchFor("open", dir, platform), reveal, `${platform} open matches reveal`);
  }
});

test("a path stays one argument whatever it contains", () => {
  const path = "/tmp/my runs & 'quotes'/rapport-café.trx";
  for (const platform of ["win32", "darwin", "linux"] as NodeJS.Platform[]) {
    const launch = launchFor("open", { kind: "file", path }, platform)!;
    // Windows names the shell entry point first, so the path is the last argv
    // entry rather than the only one.
    assert.deepEqual(launch.args.at(-1), path, `${platform} must pass the path whole`);
    assert.equal(launch.args.filter((a) => a.includes(path)).length, 1, `${platform} must pass it once`);
  }
});

test("the folder of a merged run is the deepest one holding every file", () => {
  assert.equal(commonParent(["/repo/a/x.trx", "/repo/b/y.trx"], "linux"), "/repo");
  assert.equal(commonParent(["/repo/a/x.trx", "/repo/a/y.trx"], "linux"), "/repo/a");
  assert.equal(commonParent(["/repo/x.trx"], "linux"), "/repo");
  // Roots are only paths once they end in a separator.
  assert.equal(commonParent(["/x.trx", "/y.trx"], "linux"), "/");
  assert.equal(commonParent([`C:${sep}a${sep}x.trx`, `C:${sep}b${sep}y.trx`], "win32"), `C:${sep}`);
  // Windows spells one place several ways; separate drives are separate places.
  assert.equal(commonParent([`C:${sep}Repo${sep}a${sep}x.trx`, `c:${sep}repo${sep}b${sep}y.trx`], "win32"), `C:${sep}Repo`);
  assert.equal(commonParent([`C:${sep}a${sep}x.trx`, `D:${sep}a${sep}y.trx`], "win32"), null);
  assert.equal(commonParent([], "linux"), null);
});

test("opening acts on the server's own report path", async () => {
  await withServer(async ({ token, path, launches, reveal }) => {
    const res = await reveal(token, { mode: "open" });
    assert.equal(res.status, 200);
    assert.deepEqual(launches, [launchFor("open", { kind: "file", path }, process.platform)]);
  });
});

test("a path in the request body is ignored", async () => {
  await withServer(async ({ token, path, launches, reveal }) => {
    const res = await reveal(token, { mode: "open", path: "/etc/passwd" });
    assert.equal(res.status, 200);
    assert.deepEqual(launches, [launchFor("open", { kind: "file", path }, process.platform)]);
  });
});

test("a bad token launches nothing", async () => {
  await withServer(async ({ launches, reveal }) => {
    assert.equal((await reveal("nope", { mode: "open" })).status, 403);
    assert.equal((await reveal(undefined, { mode: "open" })).status, 403);
    assert.equal(launches.length, 0);
  });
});

test("an unknown mode is refused", async () => {
  await withServer(async ({ token, launches, reveal }) => {
    const res = await reveal(token, { mode: "delete" });
    assert.equal(res.status, 400);
    assert.equal(launches.length, 0);
  });
});

test("GET is rejected", async () => {
  await withServer(async ({ url, launches }) => {
    assert.equal((await fetch(new URL("/reveal", url))).status, 405);
    assert.equal(launches.length, 0);
  });
});

test("a report deleted since it was loaded is reported, not launched", async () => {
  await withServer(async ({ token, path, launches, reveal }) => {
    rmSync(path);
    const res = await reveal(token, { mode: "reveal" });
    assert.equal(res.status, 404);
    assert.equal(launches.length, 0);
  });
});

// The picker label is a display name: it is disambiguated when two runs share a
// basename, and a merged run invents one for a set of files. Resolving it back
// to a path would reach whichever file carries it.
test("the target follows the load, not the picker label", async () => {
  const root = mkdtempSync(join(tmpdir(), "reveal-"));
  const a = write(join(root, "a", REPORT));
  const b = write(join(root, "b", REPORT));
  const handle = await createResultsServer({ port: 0, watch: false, coverage: false, resultsFile: a, launch: () => {} });
  try {
    assert.deepEqual(handle.revealTarget(), { kind: "file", path: a });
    // Same basename, so both runs compete for the same label.
    handle.loadInput({ resultsFile: b });
    assert.deepEqual(handle.revealTarget(), { kind: "file", path: b }, "the run just loaded is the one revealed");
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a merged run reveals the folder its files share", async () => {
  const root = mkdtempSync(join(tmpdir(), "reveal-"));
  const a = write(join(root, "billing", "run.trx"));
  const b = write(join(root, "shipping", "run.trx"));
  const launches: Launch[] = [];
  const handle = await createResultsServer({
    port: 0,
    watch: false,
    coverage: false,
    launch: (l) => { launches.push(l); },
  });
  try {
    const opened = handle.openFiles({ name: "Both projects", files: [a, b] });
    assert.equal(opened.ok, true);
    assert.deepEqual(handle.revealTarget(), { kind: "dir", path: root });

    const res = await fetch(new URL("/reveal", handle.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${handle.askToken}` },
      body: JSON.stringify({ mode: "reveal" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(launches, [launchFor("reveal", { kind: "dir", path: root }, process.platform)]);

    // Drilling into one member is a single run again, so it names its file.
    assert.equal(handle.loadNamed(opened.sources![0].label), true);
    assert.deepEqual(handle.revealTarget(), { kind: "file", path: a });
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("results the agent reported have nothing to reveal", async () => {
  const handle = await createResultsServer({ port: 0, watch: false, coverage: false, launch: () => {} });
  try {
    handle.setResults([{ name: "reported by an action", status: "pass" }]);
    assert.equal(handle.revealTarget(), null);
    const res = await fetch(new URL("/reveal", handle.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${handle.askToken}` },
      body: JSON.stringify({ mode: "open" }),
    });
    assert.equal(res.status, 404);
  } finally {
    await handle.close();
  }
});

// An action replaces the rows but leaves the sources loaded, so the file is
// still there to be found -- it just no longer describes what is on screen.
test("an action replacing a loaded run leaves nothing to reveal", async () => {
  const root = mkdtempSync(join(tmpdir(), "reveal-"));
  const path = write(join(root, REPORT));
  const handle = await createResultsServer({ port: 0, watch: false, coverage: false, resultsFile: path, launch: () => {} });
  try {
    assert.deepEqual(handle.revealTarget(), { kind: "file", path });
    handle.setResults([{ name: "reported by an action", status: "pass" }]);
    assert.equal(handle.revealTarget(), null, "set_results replaced the run");

    handle.loadNamed(handle.currentFile());
    assert.deepEqual(handle.revealTarget(), { kind: "file", path }, "reloading the file restores it");
    handle.clearResults();
    assert.equal(handle.revealTarget(), null, "clear_all replaced the run too");
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a host that cannot launch answers with an error", async () => {
  const root = mkdtempSync(join(tmpdir(), "reveal-"));
  const path = write(join(root, REPORT));
  const handle = await createResultsServer({
    port: 0,
    watch: false,
    coverage: false,
    resultsFile: path,
    launch: () => { throw new Error("no opener installed"); },
  });
  try {
    const res = await fetch(new URL("/reveal", handle.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${handle.askToken}` },
      body: JSON.stringify({ mode: "open" }),
    });
    assert.equal(res.status, 502);
    assert.equal((await res.json() as { ok: boolean }).ok, false);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
