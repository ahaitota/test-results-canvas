const ROWKEY_SEP = "\u001f"; // ASCII Unit Separator: non-printable, so it never appears in data
// Stable fields — what makes two rows "the same test" across runs.
export function rowIdentity(t) {
    return [
        t.framework || "", t.storage || "", t.suite || "", t.className || "", t.name || "",
        t.computerName || "", t.method || "", t.adapter || "",
    ].join(ROWKEY_SEP);
}
// Volatile signature — used only to MATCH a row to its prior key, never keyed on.
export function occurrenceSig(t) {
    return [
        t.startTime || "", t.endTime || "", t.durationMs == null ? "" : String(t.durationMs),
        t.status || "", t.message || "",
    ].join(ROWKEY_SEP);
}
// Key every row in `next`, reconciling against the previous payload's rows and keys.
// `seq` (identity -> next ordinal) persists across payloads so a fresh key can never
// collide with a live one. Returns keys instead of mutating rows, so callers can hold
// them as state.
export function reconcileRowKeys(next, prev, prevKeys, seq) {
    const priorBySig = new Map(); // identity+sig -> queue of prior keys
    for (let i = 0; i < prev.length; i++) {
        const key = prevKeys[i];
        if (key == null)
            continue;
        const sig = rowIdentity(prev[i]) + ROWKEY_SEP + occurrenceSig(prev[i]);
        let queue = priorBySig.get(sig);
        if (!queue) {
            queue = [];
            priorBySig.set(sig, queue);
        }
        queue.push(key);
    }
    const keys = [];
    const reused = new Set();
    for (const t of next) {
        const id = rowIdentity(t);
        const queue = priorBySig.get(id + ROWKEY_SEP + occurrenceSig(t));
        if (queue && queue.length) { // exact identity+signature match -> reuse
            const key = queue.shift();
            keys.push(key);
            reused.add(key);
        }
        else { // no proof it's the same row -> fresh key
            const n = seq.get(id) || 0;
            seq.set(id, n + 1);
            keys.push(id + ROWKEY_SEP + "#" + n);
        }
    }
    return { keys, reused };
}
// Drop keys that no longer belong to a live row, so expansion collapses instead of
// transferring. Returns the same set when nothing changed, to avoid a re-render.
export function pruneKeys(set, reused) {
    let stale = false;
    for (const k of set)
        if (!reused.has(k)) {
            stale = true;
            break;
        }
    if (!stale)
        return set;
    const next = new Set();
    for (const k of set)
        if (reused.has(k))
            next.add(k);
    return next;
}
