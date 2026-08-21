// Pure string maths on the paths a coverage report contains.
//
// No node imports, so anything may depend on it — including classify.ts, which
// the client bundle has to reach without dragging node:fs along. Everything
// that actually touches the filesystem is in resolve.ts.

// Reports use whichever slash their platform used, so compare in forward
// slashes throughout.
export function normalizeSlashes(p: string): string {
    return String(p || "").replace(/\\/g, "/");
}

// How many trailing segments two paths share. Used to pick between files with
// the same name, e.g. src/Calc.cs vs tests/Calc.cs.
export function commonSuffixSegments(a: string, b: string): number {
    const left = normalizeSlashes(a).toLowerCase().split("/").filter(Boolean);
    const right = normalizeSlashes(b).toLowerCase().split("/").filter(Boolean);
    let n = 0;
    while (n < left.length && n < right.length && left[left.length - 1 - n] === right[right.length - 1 - n]) n++;
    return n;
}
