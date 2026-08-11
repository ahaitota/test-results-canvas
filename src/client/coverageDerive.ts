// Pure derivations for the coverage view. Kept out of the components so the
// grouping and bucketing rules can be reasoned about (and tested) on their own,
// matching how derive.ts serves the results list.

import type { CoverageFileSummary, CoveragePayload } from "../coverage/payload.js";

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

export interface CoverageGroup {
  key: string;
  files: CoverageFileSummary[];
  coveredLines: number;
  totalLines: number;
  percent: number | null;
}

// Group the file list by folder, worst coverage first. Sorting by percentage
// rather than alphabetically puts the folders that need work at the top, which
// is the whole point of the view; ties fall back to name for stability.
export function buildCoverageGroups(files: readonly CoverageFileSummary[], query: string): CoverageGroup[] {
  const q = query.trim().toLowerCase();
  const map = new Map<string, CoverageGroup>();
  for (const f of files) {
    if (q && f.path.toLowerCase().indexOf(q) === -1) continue;
    const key = folderOf(f.path);
    let g = map.get(key);
    if (!g) {
      g = { key, files: [], coveredLines: 0, totalLines: 0, percent: null };
      map.set(key, g);
    }
    g.files.push(f);
    g.coveredLines += f.coveredLines;
    g.totalLines += f.totalLines;
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.percent = g.totalLines ? Math.round((g.coveredLines / g.totalLines) * 100) : null;
    g.files.sort((a, b) => (a.percent ?? 101) - (b.percent ?? 101) || a.path.localeCompare(b.path));
  }
  groups.sort((a, b) => (a.percent ?? 101) - (b.percent ?? 101) || a.key.localeCompare(b.key));
  return groups;
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
