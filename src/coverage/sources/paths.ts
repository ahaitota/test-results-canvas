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

// True when one spelling contains the whole of the other at a folder boundary.
// Sharing some trailing folders is not enough -- packages/a/src/index.ts and
// packages/b/src/index.ts share two.
function containsWhole(a: string, b: string): boolean {
    return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

// Which candidate a path refers to, or undefined when more than one could.
//
// Tried in rounds: an identical spelling, then one spelling containing the whole
// of the other, then both of those again ignoring case. A later round is only
// reached when the earlier ones matched nothing, and a round matching several
// candidates is ambiguous -- choosing one of them would attribute a file's
// coverage to a different file. Either side may be spelled several ways, since
// git, the report and the filesystem each name the same file their own way.
export function matchPath<T>(
    wanted: readonly (string | undefined)[],
    candidates: readonly T[],
    spellingsOf: (candidate: T) => readonly (string | undefined)[],
): T | undefined {
    const mine = wanted.filter((s): s is string => Boolean(s)).map(normalizeSlashes);
    if (!mine.length) return undefined;

    const rounds: ((a: string, b: string) => boolean)[] = [
        (a, b) => a === b,
        containsWhole,
        (a, b) => {
            const x = a.toLowerCase();
            const y = b.toLowerCase();
            return x === y || containsWhole(x, y);
        },
    ];

    for (const test of rounds) {
        let found: T | undefined;
        let count = 0;
        for (const candidate of candidates) {
            const theirs = spellingsOf(candidate);
            if (!mine.some((a) => theirs.some((b) => b && test(a, normalizeSlashes(b))))) continue;
            if (++count > 1) return undefined;
            found = candidate;
        }
        if (count === 1) return found;
    }
    return undefined;
}

// Look a path up in a map keyed by its exact spelling. Case is only ignored as
// a fallback, and only when one entry can be meant by it: two keys differing in
// case are two files where the filesystem says so.
export function findByPath<T>(entries: ReadonlyMap<string, T>, path: string): T | undefined {
    const wanted = normalizeSlashes(path);
    const exact = entries.get(wanted);
    if (exact !== undefined) return exact;
    const lower = wanted.toLowerCase();
    let found: T | undefined;
    for (const [key, value] of entries) {
        if (key.toLowerCase() !== lower) continue;
        if (found !== undefined) return undefined;
        found = value;
    }
    return found;
}
