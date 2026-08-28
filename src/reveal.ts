// Chooses the desktop-shell command that reveals or opens a run. Pure and
// host-free -- it launches nothing -- so the platform matrix and the folder a
// merged run resolves to are unit-testable.
import { dirname, sep } from "node:path";

export type RevealMode = "reveal" | "open";

// What the shell is pointed at: the file a single run was read from, or the
// folder holding a merged run's files, which has no single file to name.
export interface RevealTarget {
    kind: "file" | "dir";
    path: string;
}

// A command and its argv. The path is always its own entry, never spliced into
// a shell string, so spaces, Unicode and metacharacters stay data.
export interface Launch {
    command: string;
    args: string[];
}

// The deepest folder holding every file in a run. Null when they share none --
// separate Windows drives, or a set that meets only above the root. Case is
// folded on Windows, where two spellings of a drive are one place.
export function commonParent(paths: readonly string[], platform: NodeJS.Platform): string | null {
    if (!paths.length) return null;
    const win = platform === "win32";
    const fold = (s: string) => (win ? s.toLowerCase() : s);
    const segments = (p: string) => dirname(p).split(/[\\/]/);

    let shared = segments(paths[0]);
    for (let i = 1; i < paths.length; i++) {
        const parts = segments(paths[i]);
        let n = 0;
        while (n < shared.length && n < parts.length && fold(shared[n]) === fold(parts[n])) n++;
        shared = shared.slice(0, n);
    }
    if (!shared.length) return null;
    // A lone segment is a root, and a root is only a path once it ends in a
    // separator: "C:" means "wherever C: is pointing", and "" means "/".
    if (shared.length === 1) {
        if (/^[a-zA-Z]:$/.test(shared[0])) return shared[0] + sep;
        return shared[0] === "" ? "/" : shared[0];
    }
    return shared.join(win ? sep : "/");
}

// null means the host has no opener we know of; the caller reports that rather
// than guessing at a command.
export function launchFor(mode: RevealMode, target: RevealTarget, platform: NodeJS.Platform): Launch | null {
    // A folder is its own destination: revealing it and opening it are the same
    // act, and only a file can be selected inside the folder that holds it.
    const select = target.kind === "file" && mode === "reveal";
    switch (platform) {
        case "win32":
            // explorer.exe selects with `/select,` and opens a folder, but handed
            // a file it only launches types that already have a handler and does
            // nothing at all for the rest. ShellExec_RunDLL is the shell's own
            // opener, so an unhandled type raises "Open with" rather than failing
            // in silence. Exit codes stay unreliable either way (explorer.exe
            // reports failure on success), so only a failure to spawn counts.
            if (select) return { command: "explorer.exe", args: [`/select,${target.path}`] };
            return target.kind === "dir"
                ? { command: "explorer.exe", args: [target.path] }
                : { command: "rundll32.exe", args: ["shell32.dll,ShellExec_RunDLL", target.path] };
        case "darwin":
            return { command: "open", args: select ? ["-R", target.path] : [target.path] };
        case "linux":
            // No portable "select this file", so revealing a file opens its folder.
            return { command: "xdg-open", args: [select ? dirname(target.path) : target.path] };
        default:
            return null;
    }
}
