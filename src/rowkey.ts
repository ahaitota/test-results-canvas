// Keys a test row's expand state so it survives re-renders and live refreshes.
// A key is a unique, opaque token: rowIdentity + "#" + ordinal. The ordinal is a
// per-identity sequence — NOT derived from volatile data — so a key never changes
// when timing/status/message change between runs.
//
// Keys are assigned once per payload by reconciling the new rows against the previous one:
//   - reuse a prior key only for an exact rowIdentity + occurrenceSig match;
//     equal-signature rows pair up in arrival order (deterministic tie ordinals).
//   - rows with no exact prior match get a fresh key.
//   - prior keys left unmatched are dropped from the expansion sets, so an ambiguous
//     retry collapses instead of transferring expansion to a possibly different row.
// Ids aren't used: TRX executionId changes each run; JUnit ids repeat/miss.
import type { TestResult } from "./types.js";

const US = "\u001f"; // delimiter that never appears in data

// Stable fields — what makes two rows "the same test" across runs.
export function rowIdentity(t: TestResult): string {
  return [
    t.framework || "", t.storage || "", t.suite || "", t.className || "", t.name || "",
    t.computerName || "", t.method || "", t.adapter || "",
  ].join(US);
}

// Volatile signature — used only to MATCH a row to its prior key, never keyed on.
export function occurrenceSig(t: TestResult): string {
  return [
    t.startTime || "", t.endTime || "", t.durationMs == null ? "" : String(t.durationMs),
    t.status || "", t.message || "",
  ].join(US);
}

export interface Reconciled {
  keys: string[];      // one key per row in `next`, same order
  reused: Set<string>; // prior keys matched to a new row; the rest are stale
}

// Key every row in `next`, reconciling against the previous payload's rows and keys.
// `seq` (identity -> next ordinal) persists across payloads so a fresh key can never
// collide with a live one. Returns keys instead of mutating rows, so callers can hold
// them as state.
export function reconcileRowKeys(
  next: readonly TestResult[],
  prev: readonly TestResult[],
  prevKeys: readonly string[],
  seq: Map<string, number>,
): Reconciled {
  const priorBySig = new Map<string, string[]>(); // identity+sig -> queue of prior keys
  for (let i = 0; i < prev.length; i++) {
    const key = prevKeys[i];
    if (key == null) continue;
    const sig = rowIdentity(prev[i]) + US + occurrenceSig(prev[i]);
    let queue = priorBySig.get(sig);
    if (!queue) { queue = []; priorBySig.set(sig, queue); }
    queue.push(key);
  }

  const keys: string[] = [];
  const reused = new Set<string>();
  for (const t of next) {
    const id = rowIdentity(t);
    const queue = priorBySig.get(id + US + occurrenceSig(t));
    if (queue && queue.length) {          // exact identity+signature match -> reuse
      const key = queue.shift() as string;
      keys.push(key);
      reused.add(key);
    } else {                              // no proof it's the same row -> fresh key
      const n = seq.get(id) || 0;
      seq.set(id, n + 1);
      keys.push(id + US + "#" + n);
    }
  }
  return { keys, reused };
}

// Drop keys that no longer belong to a live row, so expansion collapses instead of
// transferring. Returns the same set when nothing changed, to avoid a re-render.
export function pruneKeys(set: Set<string>, reused: Set<string>): Set<string> {
  let stale = false;
  for (const k of set) if (!reused.has(k)) { stale = true; break; }
  if (!stale) return set;
  const next = new Set<string>();
  for (const k of set) if (reused.has(k)) next.add(k);
  return next;
}
