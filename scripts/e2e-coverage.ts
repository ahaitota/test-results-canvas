// Run the e2e suite with coverage collection turned on, for both halves of what
// it exercises. Variables are set here rather than inline because cmd.exe
// treats `COVERAGE=1 playwright` as part of the command.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { CLIENT_BUILD_DIR } from "../e2e/coverage-collect.js";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

// Stale raw coverage would be merged in as if this run had produced it, quietly
// crediting the report with tests that no longer exist.
rmSync(join(ROOT, "test-results", "v8-raw"), { recursive: true, force: true });
const nodeDir = join(ROOT, "test-results", "v8-node");
rmSync(nodeDir, { recursive: true, force: true });

// The shipped bundle is minified, which makes it nearly useless to measure:
// whole functions collapse onto one line, so the source map can only place a
// handful of positions per file and a 300-line component reports two dozen
// lines. The bundle is rebuilt unminified for the run -- same code, same
// behaviour -- so every statement keeps a line of its own to be mapped back to.
//
// esbuild's API is called directly rather than through npx: spawning a shell
// with arguments is both slower and a needless injection surface.
function buildClient(minify: boolean): void {
    buildSync({
        entryPoints: [join(ROOT, "src", "client", "main.tsx")],
        outfile: join(ROOT, "dist", "client", "app.js"),
        bundle: true,
        format: "esm",
        target: "es2022",
        jsx: "automatic",
        jsxImportSource: "preact",
        sourcemap: true,
        minify,
        absWorkingDir: ROOT,
    });
}

buildClient(false);

const child = spawn(
    process.execPath,
    [join(ROOT, "node_modules", "@playwright", "test", "cli.js"), "test", ...process.argv.slice(2)],
    { cwd: ROOT, stdio: "inherit", env: { ...process.env, COVERAGE: "1", NODE_V8_COVERAGE: nodeDir } },
);
child.on("exit", (code, signal) => {
    // The measured bundle and its map are kept, because the V8 ranges are byte
    // offsets into *this* build and mean nothing against the minified one that
    // is about to replace it.
    mkdirSync(CLIENT_BUILD_DIR, { recursive: true });
    for (const name of ["app.js", "app.js.map"]) {
        try {
            copyFileSync(join(ROOT, "dist", "client", name), join(CLIENT_BUILD_DIR, name));
        } catch {
            // A run that failed before the build finished has nothing to keep.
        }
    }
    // dist/ is committed and CI fails when a build leaves it dirty, so the
    // shipped bundle is always put back -- including after a failed run, which
    // is exactly when someone is most likely to forget.
    buildClient(true);
    process.exit(signal ? 1 : code ?? 0);
});
