// Live results stream. Owns the host subscription and the row-key reconciliation
// that lets expansion state follow a test rather than its position in the array.
import { useEffect, useRef, useState } from "preact/hooks";
import type { CanvasState, TestResult } from "../types";
import { reconcileRowKeys } from "../rowkey.js";
import { bridge } from "@bridge";

// Kept as an alias: this is the payload shape the host pushes.
export type ServerState = CanvasState;

// Plus the row keys reconciled for that payload -- stored together so a row and
// its key can never come from different payloads.
export interface AppState extends ServerState {
  keys: string[];
}

// `onReconcile` is handed the keys that survived the new payload, so the caller
// can drop expansion state belonging to rows that are gone.
export function useResultsStream(onReconcile: (reused: Set<string>) => void) {
  const [state, setState] = useState<AppState>({ title: bridge.initialTitle, results: [], file: "", files: [], keys: [] });
  const prevPayload = useRef<{ results: TestResult[]; keys: string[] }>({ results: [], keys: [] });
  const keySeq = useRef(new Map<string, number>());
  // Read through a ref so the subscription never needs re-creating.
  const reconcileRef = useRef(onReconcile);
  reconcileRef.current = onReconcile;

  useEffect(() => bridge.subscribe((next) => {
    const results = next.results || [];
    const prev = prevPayload.current;
    const { keys, reused } = reconcileRowKeys(results, prev.results, prev.keys, keySeq.current);
    prevPayload.current = { results, keys };
    setState({ ...next, results, keys });
    reconcileRef.current(reused);
  }), []);

  return { state, setState };
}
