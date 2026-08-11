// Pure derivations for the coverage view. Kept out of the components so the
// grouping and bucketing rules can be reasoned about (and tested) on their own,
// matching how derive.ts serves the results list.

import type { CoveragePayload, UncoveredRegion } from "../coverage/payload.js";

// Coverage bands. The thresholds are the ones most CI gates use, so the colour
// a user sees here matches the verdict their pipeline gives.
export type CoverageBand = "high" | "medium" | "low" | "none";

export function bandOf(percent: number | null): CoverageBand {
  if (percent == null) return "none";
  if (percent >= 80) return "high";
  if (percent >= 50) return "medium";
  return "low";
}

// Directory part of a report path, normalised to forward slashes. Files at the
// root group under "." so every file lands in exactly one group.
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

// --- the merged file list ---------------------------------------------------
//
// One row per file, carrying everything the three separate lists used to show.
// The lists overlapped rather than partitioned: a changed file with an untested
// block appeared three times, with a third of the story in each place, and
// nothing on screen said they were the same file.

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
  // The report has data for this file. False means "unknown", not "uncovered" --
  // a distinction the row must keep visible, because the two look identical in
  // a percentage and mean opposite things about the work left to do.
  measured: boolean;
  // Coverage of this file's changed lines only.
  newCovered: number;
  newTotal: number;
  newUncovered: number[];
  // What git says changed, regardless of coverage. For an unmeasured file this
  // is the only size it has -- the difference between a new module and a typo.
  changedLines: number;
  // Ranked untested blocks, worst first. Empty for a file that has none, and
  // also for one whose blocks fell outside the server's ranking cut-off.
  regions: UncoveredRegion[];
  // Which band of attention the row belongs to; see rowTier.
  tier: number;
}

// Path identity across the three sources. The coverage report, git and the
// filesystem each have their own opinion about separators and case, so matching
// raw strings silently produces duplicate rows on Windows -- exactly the class
// of bug that put separator normalisation into resolveReportSources.
function pathKey(path: string): string {
  return String(path || "").replace(/\\/g, "/").toLowerCase();
}

// Rank order for "most actionable". The tiers reproduce the old section order --
// new code first, then the biggest gaps, then everything else -- so the merge
// loses no prioritisation, it just stops repeating files to express it.
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

// Sort comparators. Within a tier the worst offender leads: most untested new
// lines, then the largest gap, then the lowest percentage.
function byActionable(a: CoverageRow, b: CoverageRow): number {
  return a.tier - b.tier
    // Within the unmeasured tier nothing else can separate rows: no percentage,
    // no gaps, no covered lines. Size is the only fact they carry, and without
    // it fifteen blind spots list alphabetically and read identically.
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

  for (const f of coverage.files) {
    rows.set(pathKey(f.path), {
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
      changedLines: 0,
      regions: [],
      tier: 4,
    });
  }

  // Changed files the report never mentions are absent from `files` entirely,
  // so they have to be added here or the merged list would quietly drop the
  // single strongest signal the panel has: new code no test even loaded.
  for (const pf of coverage.patch?.files ?? []) {
    const key = pathKey(pf.path);
    let row = rows.get(key);
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
        changedLines: 0,
        regions: [],
        tier: 0,
      };
      rows.set(key, row);
    }
    row.changed = true;
    if (pf.unmeasured) row.measured = false;
    row.newCovered = pf.coveredLines.length;
    row.newTotal = pf.coveredLines.length + pf.uncoveredLines.length;
    row.newUncovered = pf.uncoveredLines;
    row.changedLines = pf.changedLines ?? 0;
  }

  for (const h of coverage.hotspots ?? []) {
    rows.get(pathKey(h.path))?.regions.push(h);
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

// What the row says about itself beyond its percentage: the part the old "New
// code" and "Worth covering" sections carried.
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
  const top = r.regions[0];
  if (top) {
    const where = top.start === top.end ? `line ${top.start}` : `lines ${top.start}\u2013${top.end}`;
    const more = r.regions.length - 1;
    bits.push(`biggest gap ${where} (${top.lines} untested)${more > 0 ? `, +${more} more block${more === 1 ? "" : "s"}` : ""}`);
  }
  return bits.join(" \u00B7 ");
}

// Contiguous runs, so a list of line numbers can be shown as "40-58" rather
// than nineteen separate numbers. Mirrors the server-side toRanges(), including
// the one-line gap tolerance, so both ends describe a region the same way.
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

// The single number to show in the header. Production-only coverage is what
// people mean by "our coverage"; the overall figure is the fallback when a
// report contains nothing classifiable as production code.
export function headlinePercent(coverage: CoveragePayload | null): number | null {
  if (!coverage) return null;
  return coverage.productionPercent ?? coverage.totals.percent;
}

// The fraction to print beside that number, drawn from the same population.
// Pairing a production-only percentage with the whole report's line count would
// invite exactly the arithmetic the reader is about to attempt: on a report
// that measures its test project too, "80% covered · 14/15 lines" is two
// different measurements sitting next to each other.
export function headlineTotals(coverage: CoveragePayload | null): { coveredLines: number; totalLines: number; files: number } {
  if (!coverage) return { coveredLines: 0, totalLines: 0, files: 0 };
  if (coverage.productionPercent != null && coverage.productionTotals) return coverage.productionTotals;
  return coverage.totals;
}

// One-line description of the change set, e.g. "3 of 18 new lines untested".
//
// Files the report never measured are always named. Reporting only the measured
// subset reads as if it were the whole change set, which understates the work
// left to do: a brand new file that no test imports contributes no uncovered
// lines precisely because nothing observed it.
export function patchHeadline(coverage: CoveragePayload | null): string {
  const patch = coverage?.patch;
  if (!patch) return "";
  const uncovered = patch.total - patch.covered;
  const blind = patch.unmeasuredFiles > 0
    ? `${patch.unmeasuredFiles} changed file${patch.unmeasuredFiles === 1 ? "" : "s"} with no coverage data`
    : "";
  if (patch.total === 0 && patch.unmeasuredFiles > 0) return blind;
  const measured = uncovered === 0
    ? `All ${patch.total} changed line${patch.total === 1 ? " is" : "s are"} covered`
    : `${uncovered} of ${patch.total} changed line${patch.total === 1 ? "" : "s"} not covered`;
  return blind ? `${measured}, plus ${blind}` : measured;
}
