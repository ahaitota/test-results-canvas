// Pure derivations for the coverage view, kept out of the components so the
// grouping and bucketing rules can be tested on their own, as derive.ts does
// for the results list.

import type { CoveragePayload, UncoveredRegion } from "../coverage/model/payload.js";

// The thresholds most CI gates use, so the colour here matches their verdict.
export type CoverageBand = "high" | "medium" | "low" | "none";

export function bandOf(percent: number | null): CoverageBand {
  if (percent == null) return "none";
  if (percent >= 80) return "high";
  if (percent >= 50) return "medium";
  return "low";
}

// Files at the root group under "." so every file lands in exactly one group.
export function folderOf(path: string): string {
  const p = String(path || "").replace(/\\/g, "/");
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : ".";
}

export function baseOf(path: string): string {
  const p = String(path || "").replace(/\\/g, "/");
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// One row per file: coverage, whether the change set touched it, how its
// changed lines fared, and its worst untested block.

export type CoverageSort = "actionable" | "name" | "coverage";

export interface CoverageRow {
  path: string;
  folder: string;
  name: string;
  // Report numbers. Zeroed for a file the report never mentions.
  coveredLines: number;
  totalLines: number;
  percent: number | null;
  hasSource: boolean;
  isTest: boolean;
  changed: boolean;
  // False means "unknown", not "uncovered" -- the two look identical in a
  // percentage and mean opposite things.
  measured: boolean;
  // Coverage of this file's changed lines only.
  newCovered: number;
  newTotal: number;
  newUncovered: number[];
  // Changed lines the report has no entry for. Not the same as uncovered: the
  // report was never asked about them.
  newUnknown: number;
  // What git says changed, regardless of coverage. For an unmeasured file this
  // is the only size it has.
  changedLines: number;
  // Ranked untested blocks, worst first.
  regions: UncoveredRegion[];
  tier: number;
}

// Case is left alone: two paths differing only in case are two files where the
// filesystem says so.
function pathKey(path: string): string {
  return String(path || "").replace(/\\/g, "/");
}

// Rank order for "most actionable": new code first, then the biggest gaps.
function rowTier(r: CoverageRow): number {
  if (r.isTest) return 5;
  // Changed code nothing observed: the report cannot even say it is untested.
  if (r.changed && !r.measured) return 0;
  if (r.changed && r.newUncovered.length > 0) return 1;
  if (r.changed) return 2;
  if ((r.percent ?? 100) < 100) return 3;
  return 4;
}

function untestedLines(r: CoverageRow): number {
  return Math.max(0, r.totalLines - r.coveredLines);
}

// Within a tier the worst offender leads: most untested new lines, then the
// largest gap, then the lowest percentage.
function byActionable(a: CoverageRow, b: CoverageRow): number {
  return a.tier - b.tier
    // Size is the only fact the unmeasured tier carries.
    || (a.tier === 0 ? b.changedLines - a.changedLines : 0)
    || b.newUncovered.length - a.newUncovered.length
    || (b.regions[0]?.score ?? 0) - (a.regions[0]?.score ?? 0)
    || untestedLines(b) - untestedLines(a)
    || (a.percent ?? 101) - (b.percent ?? 101)
    || a.path.localeCompare(b.path);
}

export function buildCoverageRows(
  coverage: CoveragePayload | null,
  query: string,
  sort: CoverageSort = "actionable",
): CoverageRow[] {
  if (!coverage) return [];
  const rows = new Map<string, CoverageRow>();
  // A key two rows share holds null, because no single row can be the one meant.
  const byLower = new Map<string, CoverageRow | null>();

  function addRow(key: string, row: CoverageRow): void {
    rows.set(key, row);
    const lower = key.toLowerCase();
    byLower.set(lower, byLower.has(lower) ? null : row);
  }

  // Exact first. A Windows report can spell a path in a different case than git
  // does, so case is ignored after, but only when one row can be meant by it.
  function findRow(path: string): CoverageRow | undefined {
    const key = pathKey(path);
    return rows.get(key) ?? byLower.get(key.toLowerCase()) ?? undefined;
  }

  for (const f of coverage.files) {
    addRow(pathKey(f.path), {
      path: f.path,
      folder: folderOf(f.path),
      name: baseOf(f.path),
      coveredLines: f.coveredLines,
      totalLines: f.totalLines,
      percent: f.percent,
      hasSource: f.hasSource,
      isTest: f.isTest,
      changed: f.changed,
      measured: true,
      newCovered: 0,
      newTotal: 0,
      newUncovered: [],
      newUnknown: 0,
      changedLines: 0,
      regions: [],
      tier: 4,
    });
  }

  // Changed files the report never mentions are absent from `files`, so they
  // are added here or the list would drop the strongest signal there is.
  for (const pf of coverage.patch?.files ?? []) {
    let row = findRow(pf.path);
    if (!row) {
      row = {
        path: pf.path,
        folder: folderOf(pf.path),
        name: baseOf(pf.path),
        coveredLines: 0,
        totalLines: 0,
        percent: null,
        hasSource: Boolean(pf.absPath),
        isTest: false,
        changed: true,
        measured: false,
        newCovered: 0,
        newTotal: 0,
        newUncovered: [],
        newUnknown: 0,
        changedLines: 0,
        regions: [],
        tier: 0,
      };
      addRow(pathKey(pf.path), row);
    }
    row.changed = true;
    if (pf.unmeasured) row.measured = false;
    row.newCovered = pf.coveredLines.length;
    row.newTotal = pf.coveredLines.length + pf.uncoveredLines.length;
    row.newUncovered = pf.uncoveredLines;
    row.newUnknown = pf.unknownLines ?? 0;
    row.changedLines = pf.changedLines ?? 0;
  }

  for (const h of coverage.hotspots ?? []) {
    findRow(h.path)?.regions.push(h);
  }

  const q = query.trim().toLowerCase();
  const list = [...rows.values()].filter((r) => !q || r.path.toLowerCase().includes(q));
  for (const r of list) {
    r.regions.sort((a, b) => b.score - a.score || a.start - b.start);
    r.tier = rowTier(r);
  }

  if (sort === "name") list.sort((a, b) => a.path.localeCompare(b.path));
  else if (sort === "coverage") list.sort((a, b) => (a.percent ?? 101) - (b.percent ?? 101) || a.path.localeCompare(b.path));
  else list.sort(byActionable);
  return list;
}

// A short sentence about the row beyond its percentage: how its changed lines
// fared, and its worst untested block.
export function rowNote(r: CoverageRow): string {
  if (r.changed && !r.measured) {
    return r.changedLines > 0
      ? `${r.changedLines} changed line${r.changedLines === 1 ? "" : "s"}, none of them measured`
      : "changed, but the report never measured it";
  }
  const bits: string[] = [];
  if (r.newTotal > 0) {
    bits.push(r.newUncovered.length === 0
      ? `all ${r.newTotal} changed line${r.newTotal === 1 ? "" : "s"} covered`
      : `${r.newUncovered.length} of ${r.newTotal} changed line${r.newTotal === 1 ? "" : "s"} untested: ${fmtRanges(r.newUncovered, 4)}`);
  }
  // Only worth saying where the row would otherwise read as fully covered.
  if (r.newUnknown > 0 && r.newUncovered.length === 0) {
    bits.push(`${r.newUnknown} changed line${r.newUnknown === 1 ? "" : "s"} the report does not mention`);
  }
  const top = r.regions[0];
  if (top) {
    const where = top.start === top.end ? `line ${top.start}` : `lines ${top.start}\u2013${top.end}`;
    const more = r.regions.length - 1;
    bits.push(`biggest gap ${where} (${top.lines} untested)${more > 0 ? `, +${more} more block${more === 1 ? "" : "s"}` : ""}`);
  }
  return bits.join(" \u00B7 ");
}

// Contiguous runs, so lines show as "40-58". Mirrors the server-side
// toRanges(), including the one-line gap tolerance.
export function toRanges(lines: readonly number[]): { start: number; end: number }[] {
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: { start: number; end: number }[] = [];
  for (const line of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && line - last.end <= 2) last.end = line;
    else ranges.push({ start: line, end: line });
  }
  return ranges;
}

export function fmtRanges(lines: readonly number[], max = 6): string {
  const ranges = toRanges(lines);
  const shown = ranges.slice(0, max).map((r) => (r.start === r.end ? String(r.start) : `${r.start}\u2013${r.end}`));
  const rest = ranges.length - shown.length;
  return shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
}

// Production-only coverage is what people mean by "our coverage"; the overall
// figure is the fallback when a report has nothing classifiable as production.
export function headlinePercent(coverage: CoveragePayload | null): number | null {
  if (!coverage) return null;
  return coverage.productionPercent ?? coverage.totals.percent;
}

// The fraction printed beside that number, from the same population. Pairing a
// production-only percentage with the whole report's line count would put two
// different measurements next to each other.
export function headlineTotals(coverage: CoveragePayload | null): { coveredLines: number; totalLines: number; files: number } {
  if (!coverage) return { coveredLines: 0, totalLines: 0, files: 0 };
  if (coverage.productionPercent != null && coverage.productionTotals) return coverage.productionTotals;
  return coverage.totals;
}

// One-line description of the change set, e.g. "3 of 18 new lines untested".
// Unmeasured files are always named: reporting only the measured subset reads
// as if it were the whole change set.
export function patchHeadline(coverage: CoveragePayload | null): string {
  const patch = coverage?.patch;
  if (!patch) return "";
  const uncovered = patch.total - patch.covered;
  const unknown = patch.unknownLines ?? 0;

  const parts: string[] = [];
  if (patch.total > 0) {
    parts.push(uncovered === 0
      ? `All ${patch.total} changed line${patch.total === 1 ? " is" : "s are"} covered`
      : `${uncovered} of ${patch.total} changed line${patch.total === 1 ? "" : "s"} not covered`);
  }
  if (patch.unmeasuredFiles > 0) {
    parts.push(`${patch.unmeasuredFiles} changed file${patch.unmeasuredFiles === 1 ? "" : "s"} with no coverage data`);
  }
  // Lines the report has no entry for sit outside the percentage entirely.
  // Named only where the rest reads as a clean sweep.
  if (unknown > 0 && uncovered === 0) {
    parts.push(`${unknown} changed line${unknown === 1 ? "" : "s"} the report does not mention`);
  }

  if (!parts.length) return "";
  return parts.length === 1 ? parts[0] : `${parts[0]}, plus ${parts.slice(1).join(" and ")}`;
}
