// Headline area: the file picker, the run title, the pass/fail banner, and the
// clickable status chips that drive filtering.
import type { TestStatus } from "../types";
import type { Summary as SummaryCounts } from "./derive";
import type { GroupSource } from "./useResultsStream";
import { fmtDur } from "./format";

// Shown only for a merged run, where "6 tests" on its own hides the fact that
// they came from three different projects and one of them may be missing.
export function GroupSummary({ name, sources, total }: {
  name: string;
  sources: GroupSource[];
  total: number;
}) {
  const files = sources.length;
  return (
    <div class="group-summary" data-testid="group-summary">
      <span class="group-name" data-testid="group-name">{name}</span>
      <span class="group-counts" data-testid="group-counts">
        {`${files} file${files === 1 ? "" : "s"} \u00B7 ${total} test${total === 1 ? "" : "s"}`}
      </span>
      <span class="group-sources">
        {sources.map((s) => (
          <span class="group-source" data-testid="group-source" key={s.label}>
            {s.label}
            <span class="group-source-count">{s.count}</span>
          </span>
        ))}
      </span>
    </div>
  );
}

export function FilePicker({ files, file, onPick, onFocus }: {
  files: string[];
  file: string;
  onPick: (e: Event) => void;
  onFocus: () => void;
}) {
  return (
    <div class="controls">
      <select id="file-select" data-testid="file-select" title="Choose which results file to display" value={file} onChange={onPick} onFocus={onFocus}>
        {(files || []).map((f) => <option value={f} key={f}>{f}</option>)}
      </select>
    </div>
  );
}

export function Banner({ total, failed, passRate }: { total: number; failed: number; passRate: number | null }) {
  const plural = total === 1 ? "" : "s";
  const message = failed > 0
    ? `${failed} of ${total} test${plural} failing`
    : `All ${total} test${plural} passing`;
  return (
    <div class={"banner" + (total ? (failed > 0 ? " fail" : " pass") : "")} data-testid="banner">
      {total > 0 && <>{message}{passRate != null && <span class="rate">{" \u00B7 " + passRate + "% pass rate"}</span>}</>}
    </div>
  );
}

export function Summary({ total, counts, filterStatuses, onToggleStatus, coveragePercent, onCoverage }: {
  total: number;
  counts: SummaryCounts;
  filterStatuses: Set<TestStatus>;
  onToggleStatus: (s: TestStatus) => void;
  // Null when the run produced no coverage, in which case no chip is shown.
  coveragePercent?: number | null;
  onCoverage?: () => void;
}) {
  const chip = (status: TestStatus, text: string) => (
    <span
      class={"pill pill-" + status + (filterStatuses.has(status) ? " active" : "")}
      data-filter={status}
      data-testid={"chip-" + status}
      role="button"
      tabIndex={0}
      onClick={() => onToggleStatus(status)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggleStatus(status);
        }
      }}
    >
      {text}
    </span>
  );

  return (
    <div class={"summary" + (filterStatuses.size ? " filtering" : "")} data-testid="summary">
      {total > 0 && (
        <>
          {chip("pass", counts.passed + " passed")}
          {chip("fail", counts.failed + " failed")}
          {chip("skip", counts.skipped + " skipped")}
          <span class="brk"></span>
          <span class="pill pill-total" data-testid="total">{fmtDur(counts.totalDur) + " total"}</span>
          {coveragePercent != null && (
            <span
              class="pill pill-coverage"
              data-testid="chip-coverage"
              role="button"
              tabIndex={0}
              title="Show code coverage for this run"
              onClick={onCoverage}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onCoverage?.();
                }
              }}
            >
              {coveragePercent + "% covered"}
            </span>
          )}
        </>
      )}
    </div>
  );
}
