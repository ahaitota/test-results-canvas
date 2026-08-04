// Pure derivations from a results payload: summary counts, the filtered/sorted
// view, and the grouped view. Separated from the component so each step can be
// read -- and exercised -- on its own.
import type { TestResult, TestStatus } from "../types";
import type { Row, GroupBy, SortBy } from "./format";
import { matchesSearch, groupKeyOf, sortView } from "./format";

export interface Counts {
  pass: number;
  fail: number;
  skip: number;
}

export interface Group {
  key: string;
  items: Row[];
  counts: Counts;
}

export interface Summary {
  passed: number;
  failed: number;
  skipped: number;
  totalDur: number;
  passRate: number | null;
}

export function summarize(all: readonly TestResult[]): Summary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let totalDur = 0;
  for (const t of all) {
    if (t.status === "pass") passed++;
    else if (t.status === "fail") failed++;
    else if (t.status === "skip") skipped++;
    totalDur += t.durationMs || 0;
  }
  const executed = passed + failed + skipped;
  const passRate = executed ? Math.round((passed / executed) * 100) : null;
  return { passed, failed, skipped, totalDur, passRate };
}

// Rows carry their reconciled key, so filtering and sorting never separate a
// result from its identity.
export function buildView(
  all: readonly TestResult[],
  keys: readonly string[],
  filterStatuses: ReadonlySet<TestStatus>,
  query: string,
  sortBy: SortBy,
): Row[] {
  let view: Row[] = all.map((t, i) => ({ t, i, k: keys[i] }));
  if (filterStatuses.size) view = view.filter((x) => filterStatuses.has(x.t.status));
  if (query) view = view.filter((x) => matchesSearch(x.t, query));
  return sortView(view, sortBy);
}

// Groups in first-seen order, so they follow the sort the user chose.
export function buildGroups(view: readonly Row[], groupBy: GroupBy): Group[] {
  if (groupBy === "none") return [];
  const map = new Map<string, Row[]>();
  for (const x of view) {
    const k = groupKeyOf(x.t, groupBy);
    let items = map.get(k);
    if (!items) {
      items = [];
      map.set(k, items);
    }
    items.push(x);
  }
  const groups: Group[] = [];
  for (const [key, items] of map) {
    const counts: Counts = { pass: 0, fail: 0, skip: 0 };
    for (const x of items) {
      counts[x.t.status]++;
    }
    groups.push({ key, items, counts });
  }
  return groups;
}

// Rows in the order they appear on screen, which is the order jump-to-failure walks.
export function domOrder(view: readonly Row[], groups: readonly Group[], groupBy: GroupBy): Row[] {
  if (groupBy === "none") return view as Row[];
  return groups.flatMap((g) => g.items);
}
