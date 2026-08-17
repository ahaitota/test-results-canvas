// Live results stream. Owns the SSE subscription and the row-key reconciliation
// that lets expansion state follow a test rather than its position in the array.
import { useEffect, useRef, useState } from "preact/hooks";
import type { TestResult } from "../types";
import type { CoveragePayload, CoverageSuggestion } from "../coverage/payload";
import type { DiffPayload } from "../diff/payload";
import { reconcileRowKeys } from "../rowkey.js";

// What the server pushes over SSE.
export interface ServerState {
  title: string;
  results: TestResult[];
  file: string;
  files: string[];
  // Null until a coverage report is found for the loaded run.
  coverage: CoveragePayload | null;
  // How to produce coverage for this project, shown when there is none.
  coverageHint: CoverageSuggestion | null;
  // Which tests the current change touches. Null outside a git repository, or
  // when there is nothing to compare against.
  diff: DiffPayload | null;
}

// Plus the row keys reconciled for that payload -- stored together so a row and
// its key can never come from different payloads.
export interface AppState extends ServerState {
  keys: string[];
}

const INITIAL_TITLE = (window as unknown as { __INITIAL_TITLE__?: string }).__INITIAL_TITLE__ || "Test Results";

// `onReconcile` is handed the keys that survived the new payload, so the caller
// can drop expansion state belonging to rows that are gone.
export function useResultsStream(onReconcile: (reused: Set<string>) => void) {
  const [state, setState] = useState<AppState>({ title: INITIAL_TITLE, results: [], file: "", files: [], coverage: null, coverageHint: null, diff: null, keys: [] });
  const prevPayload = useRef<{ results: TestResult[]; keys: string[] }>({ results: [], keys: [] });
  const keySeq = useRef(new Map<string, number>());
  // Read through a ref so the subscription never needs re-creating.
  const reconcileRef = useRef(onReconcile);
  reconcileRef.current = onReconcile;

  useEffect(() => {
    const source = new EventSource("/events");
    source.onmessage = (e) => {
      let next: ServerState;
      try {
        next = JSON.parse(e.data);
      } catch {
        return;
      }
      const results = next.results || [];
      const prev = prevPayload.current;
      const { keys, reused } = reconcileRowKeys(results, prev.results, prev.keys, keySeq.current);
      prevPayload.current = { results, keys };
      setState({ ...next, results, keys });
      reconcileRef.current(reused);
    };
    source.addEventListener("reload", () => location.reload());
    return () => source.close();
  }, []);

  return { state, setState };
}
