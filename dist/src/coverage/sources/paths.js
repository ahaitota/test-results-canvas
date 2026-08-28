// Pure string maths on the paths a coverage report contains. No node imports,
// so the client bundle may depend on it; anything touching the filesystem lives
// in resolve.ts.
export function normalizeSlashes(p) {
    return String(p || "").replace(/\\/g, "/");
}
// Whether an absolute path names the root itself or something beneath it. Pure
// string maths on paths that are already resolved, so a symlink pointing out of
// the root still passes here; a canonical check has to have the final say.
export function withinRoot(root, candidate, ignoreCase = false) {
    const norm = (p) => {
        const slashed = normalizeSlashes(p).replace(/\/+$/, "");
        return ignoreCase ? slashed.toLowerCase() : slashed;
    };
    const r = norm(root);
    const c = norm(candidate);
    return c === r || c.startsWith(r + "/");
}
// How many trailing segments two paths share.
export function commonSuffixSegments(a, b) {
    const left = normalizeSlashes(a).toLowerCase().split("/").filter(Boolean);
    const right = normalizeSlashes(b).toLowerCase().split("/").filter(Boolean);
    let n = 0;
    while (n < left.length && n < right.length && left[left.length - 1 - n] === right[right.length - 1 - n])
        n++;
    return n;
}
// One spelling holds the whole of the other at a folder boundary. Sharing some
// trailing folders is not enough: packages/a/src/index.ts and
// packages/b/src/index.ts share two.
function containsWhole(a, b) {
    return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}
// Two resolved paths that cannot be the same file. Neither a case difference
// nor a longer prefix is proof: the first is one file on a case-insensitive
// filesystem, the second is one file reached through a different root.
function resolvedElsewhere(a, b) {
    const x = a.toLowerCase().replace(/^\/+/, "");
    const y = b.toLowerCase().replace(/^\/+/, "");
    return x !== y && !containsWhole(x, y);
}
// Which candidate a path refers to, or undefined when more than one could.
// Candidates resolved to another file are dropped, then spellings are tried in
// rounds: identical, whole-containment, and both again ignoring case. A round
// matching several candidates is ambiguous, and picking one would report a
// file's coverage against another file.
export function matchPath(wanted, all, identityOf) {
    const spellings = (id) => [id.absPath, id.path].filter((s) => Boolean(s)).map(normalizeSlashes);
    const mine = spellings(wanted);
    if (!mine.length)
        return undefined;
    const mineAbs = wanted.absPath ? normalizeSlashes(wanted.absPath) : "";
    const candidates = mineAbs
        ? all.filter((c) => {
            const theirs = identityOf(c).absPath;
            return !theirs || !resolvedElsewhere(mineAbs, normalizeSlashes(theirs));
        })
        : all;
    const rounds = [
        (a, b) => a === b,
        containsWhole,
        (a, b) => {
            const x = a.toLowerCase();
            const y = b.toLowerCase();
            return x === y || containsWhole(x, y);
        },
    ];
    for (const test of rounds) {
        let found;
        let count = 0;
        for (const candidate of candidates) {
            const theirs = spellings(identityOf(candidate));
            if (!mine.some((a) => theirs.some((b) => test(a, b))))
                continue;
            if (++count > 1)
                return undefined;
            found = candidate;
        }
        if (count === 1)
            return found;
    }
    return undefined;
}
// Case is ignored only as a fallback, and only when one entry can be meant:
// two keys differing in case are two files where the filesystem says so.
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