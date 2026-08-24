// Pure string maths on the paths a coverage report contains.
//
// No node imports, so anything may depend on it — including classify.ts, which
// the client bundle has to reach without dragging node:fs along. Everything
// that actually touches the filesystem is in resolve.ts.
// Reports use whichever slash their platform used, so compare in forward
// slashes throughout.
export function normalizeSlashes(p) {
    return String(p || "").replace(/\\/g, "/");
}
// How many trailing segments two paths share. Used to pick between files with
// the same name, e.g. src/Calc.cs vs tests/Calc.cs.
export function commonSuffixSegments(a, b) {
    const left = normalizeSlashes(a).toLowerCase().split("/").filter(Boolean);
    const right = normalizeSlashes(b).toLowerCase().split("/").filter(Boolean);
    let n = 0;
    while (n < left.length && n < right.length && left[left.length - 1 - n] === right[right.length - 1 - n])
        n++;
    return n;
}
// True when two spellings can only be the same file: equal, or one ending with
// the whole of the other at a folder boundary. Sharing some trailing folders is
// not enough -- packages/a/src/index.ts and packages/b/src/index.ts share two.
export function isSamePathOrSuffix(a, b) {
    const x = normalizeSlashes(a).toLowerCase();
    const y = normalizeSlashes(b).toLowerCase();
    if (!x || !y)
        return false;
    return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}
// Look a path up in a map keyed by its exact spelling. Case is only ignored as
// a fallback, and only when one entry can be meant by it: two keys differing in
// case are two files where the filesystem says so.
export function findByPath(entries, path) {
    const wanted = normalizeSlashes(path);
    const exact = entries.get(wanted);
    if (exact !== undefined)
        return exact;
    const lower = wanted.toLowerCase();
    let found;
    for (const [key, value] of entries) {
        if (key.toLowerCase() !== lower)
            continue;
        if (found !== undefined)
            return undefined;
        found = value;
    }
    return found;
}
//# sourceMappingURL=paths.js.map