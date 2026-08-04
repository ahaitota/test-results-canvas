// We compile against the pinned @github/copilot-sdk, but the app injects its own
// bundled copy at runtime; this catches drift. Exits 0 where the app is absent (CI).

import { existsSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP_CONFIG = join(ROOT, "tsconfig.sdk-check.json");

// The app sets COPILOT_SDK_PATH when it forks an extension; it sometimes uses
// the Windows extended-length "\\?\" prefix, which tsconfig paths can't parse.
function cleanPath(p: string): string {
    return p.replace(/^\\\\\?\\/, "").replace(/\\/g, "/");
}

// Best-effort locations, in priority order. COPILOT_SDK_PATH always wins.
function findSdk(): string | null {
    const candidates = [
        process.env.COPILOT_SDK_PATH,
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "GitHub Copilot", "copilot-sdk"),
        "/Applications/GitHub Copilot.app/Contents/Resources/copilot-sdk",
        join(homedir(), "Applications", "GitHub Copilot.app", "Contents", "Resources", "copilot-sdk"),
        join(homedir(), ".local", "share", "GitHub Copilot", "copilot-sdk"),
    ].filter((p): p is string => typeof p === "string" && p.length > 0);

    for (const dir of candidates) {
        if (existsSync(join(dir.replace(/^\\\\\?\\/, ""), "extension.d.ts"))) return dir;
    }
    return null;
}

const sdk = findSdk();
if (!sdk) {
    console.log("typecheck:sdk — SKIPPED (Copilot app not installed on this machine).");
    console.log("  This is expected in CI. Set COPILOT_SDK_PATH to check explicitly.");
    process.exit(0);
}

const entry = `${cleanPath(sdk)}/extension.d.ts`;
console.log(`typecheck:sdk — checking against the app's SDK at ${entry}`);

// Same settings as tsconfig.json, but the SDK import is redirected from the
// node_modules copy to the one the installed app will actually load.
writeFileSync(
    TMP_CONFIG,
    JSON.stringify(
        {
            extends: "./tsconfig.json",
            compilerOptions: { baseUrl: ".", paths: { "@github/copilot-sdk/extension": [entry] } },
            include: ["extension.ts", "src/**/*.ts"],
        },
        null,
        2,
    ),
);

try {
    const tsc = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
    const run = spawnSync(tsc, ["-p", TMP_CONFIG], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
    const status = run.status ?? 1;
    if (status === 0) {
        console.log("typecheck:sdk — OK, the pinned SDK agrees with the installed app.");
    } else {
        console.error("\ntypecheck:sdk — FAILED.");
        console.error("The @github/copilot-sdk version in package.json has drifted from the SDK");
        console.error("bundled with your installed Copilot app, in a way that affects this code.");
        console.error("Bump the devDependency to match the app, then fix the errors above.");
    }
    // exitCode rather than exit() so the finally block below still runs.
    process.exitCode = status;
} finally {
    rmSync(TMP_CONFIG, { force: true });
}
