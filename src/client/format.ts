// Pure, typed helpers ported from the old inline view script.
import type { TestResult, TestStatus } from "../types";

export type Row = { t: TestResult; i: number; k: string };

// Single source of truth for the toolbar's <select> choices: the options are
// rendered from these arrays and the types are derived from them, so a new
// option cannot be added without the type (and its switch) following.
export const GROUP_OPTIONS = [
  { value: "none", label: "None" },
  { value: "status", label: "Status" },
  { value: "namespace", label: "Namespace" },
  { value: "class", label: "Class" },
  { value: "suite", label: "Suite" },
  { value: "framework", label: "Framework" },
] as const;
export type GroupBy = (typeof GROUP_OPTIONS)[number]["value"];

export const SORT_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "name", label: "Name" },
  { value: "duration", label: "Duration" },
  { value: "status", label: "Outcome" },
] as const;
export type SortBy = (typeof SORT_OPTIONS)[number]["value"];

export const STATUS_WORD: Record<TestStatus, string> = { pass: "Passed", fail: "Failed", skip: "Skipped" };
export const STATUS_LABEL: Record<TestStatus, string> = { pass: "PASS", fail: "FAIL", skip: "SKIP" };

// Human-readable duration: "ms" sub-second, seconds (trimmed) under a minute, then "Nm Ss".
export function fmtDur(ms?: number): string {
  if (ms == null || !Number.isFinite(Number(ms))) return "";
  const n = Number(ms);
  if (n < 1000) return Math.round(n) + " ms";
  if (n < 60000) {
    const s = n / 1000;
    return (s < 10 ? s.toFixed(2) : s.toFixed(1)).replace(/\.?0+$/, "") + " s";
  }
  const totalSec = Math.round(n / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s ? m + "m " + s + "s" : m + "m";
}

export function fmtTime(iso?: string): string {
  if (!iso) return "";
  const mt = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(String(iso));
  return mt ? mt[1] + " " + mt[2] : String(iso);
}

// True if the free-text query matches any searchable field.
export function matchesSearch(t: TestResult, q: string): boolean {
  return [t.name, t.className, t.method, t.framework, t.suite, t.computerName, t.message]
    .some((v) => v != null && String(v).toLowerCase().indexOf(q) !== -1);
}

// Class name minus its final segment (".NET Ns.Sub.Class" / JUnit "com.example.Class").
export function namespaceOf(t: TestResult): string {
  const c = t.className || "";
  const i = c.lastIndexOf(".");
  return i > 0 ? c.slice(0, i) : c || "(no namespace)";
}

export function groupKeyOf(t: TestResult, groupBy: GroupBy): string {
  switch (groupBy) {
    case "status": return STATUS_WORD[t.status] || t.status;
    case "namespace": return namespaceOf(t);
    case "class": return t.className || "(no class)";
    case "suite": return t.suite || t.className || "(no suite)";
    case "framework": return t.framework || "(no framework)";
    case "none": return "";
  }
}

// Sort a view; ties fall back to original order (i) for stability.
export function sortView(view: Row[], sortBy: SortBy): Row[] {
  const arr = view.slice();
  switch (sortBy) {
    case "name":
      arr.sort((a, b) => String(a.t.name || "").localeCompare(String(b.t.name || "")) || a.i - b.i);
      return arr;
    case "duration": {
      const d = (x: Row) => (x.t.durationMs == null ? -1 : x.t.durationMs);
      arr.sort((a, b) => d(b) - d(a) || a.i - b.i);
      return arr;
    }
    case "status": {
      const rank: Record<TestStatus, number> = { fail: 0, skip: 1, pass: 2 };
      arr.sort((a, b) => (rank[a.t.status] ?? 9) - (rank[b.t.status] ?? 9) || a.i - b.i);
      return arr;
    }
    case "default":
      arr.sort((a, b) => a.i - b.i);
      return arr;
  }
}
