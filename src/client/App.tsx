// The Preact app: owns the cross-cutting UI state (filters, search, grouping,
// expansion) and wires the live results stream to the header, toolbar and list.
// Everything else lives in its own module; see derive.ts for the computations.
// Behaviour-frozen against the e2e suite (data-testids unchanged).
import { useEffect, useState } from "preact/hooks";
import type { TestStatus } from "../types";
import type { GroupBy, SortBy } from "./format";
import { pruneKeys } from "../rowkey.js";
import { summarize, buildView, buildGroups, domOrder } from "./derive";
import { useResultsStream } from "./useResultsStream";
import { useJumpToFailure } from "./useJumpToFailure";
import { FilePicker, Banner, Summary } from "./Summary";
import { Toolbar } from "./Toolbar";
import { ResultsList } from "./ResultsList";
import { ViewTabs } from "./ViewTabs";
import type { ViewTab } from "./ViewTabs";
import { CoverageView } from "./CoverageView";
import { headlinePercent } from "./coverageDerive";

// Add or remove one member, leaving the previous set untouched.
function toggleIn<T>(setter: (fn: (prev: Set<T>) => Set<T>) => void, key: T): void {
  setter((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
}

export function App() {
  const [filterStatuses, setFilterStatuses] = useState<Set<TestStatus>>(new Set());
  const [searchText, setSearchText] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("suite");
  const [sortBy, setSortBy] = useState<SortBy>("status");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [expandedSecondary, setExpandedSecondary] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<ViewTab>("tests");

  // A new payload can retire rows; drop their expansion rather than let it
  // transfer to whichever row happens to take their place.
  const { state, setState } = useResultsStream((reused) => {
    setExpandedRows((p) => pruneKeys(p, reused));
    setExpandedSecondary((p) => pruneKeys(p, reused));
  });

  const expandGroup = (key: string) => setCollapsedGroups((prev) => {
    const next = new Set(prev);
    next.delete(key);
    return next;
  });
  const jumper = useJumpToFailure(collapsedGroups, expandGroup);

  const all = state.results || [];
  const counts = summarize(all);
  const view = buildView(all, state.keys, filterStatuses, searchText.trim().toLowerCase(), sortBy);
  const groups = buildGroups(view, groupBy);

  // Jumping walks rows in the order they appear on screen, not payload order.
  const rowGroup = new Map<number, string>();
  for (const g of groups) {
    for (const x of g.items) rowGroup.set(x.i, g.key);
  }
  const failing = domOrder(view, groups, groupBy).filter((x) => x.t.status === "fail").map((x) => x.i);
  jumper.setNavigationOrder(failing, rowGroup);

  // The jump cursor restarts whenever the failing set could have changed.
  useEffect(() => {
    jumper.resetCursor();
  }, [state.results, groupBy, sortBy, searchText, filterStatuses]);

  const onPickFile = (e: Event) => {
    const v = (e.currentTarget as HTMLSelectElement).value;
    setState((s) => ({ ...s, file: v }));
    fetch("/load?file=" + encodeURIComponent(v)).catch(() => {});
  };
  const onFocusFiles = () => {
    fetch("/files")
      .then((r) => r.json())
      .then((d) => setState((s) => ({ ...s, files: d.files, file: d.current ?? s.file })))
      .catch(() => {});
  };

  const showingText = all.length > 0 && view.length !== all.length ? `Showing ${view.length} of ${all.length}` : "";
  const coveragePercent = headlinePercent(state.coverage);

  return (
    <>
      <FilePicker files={state.files} file={state.file} onPick={onPickFile} onFocus={onFocusFiles} />
      <div class="head"><h1><span data-testid="title">{state.title || "Test Results"}</span></h1></div>
      <Banner total={all.length} failed={counts.failed} passRate={counts.passRate} />
      <hr />
      <Summary
        total={all.length}
        counts={counts}
        filterStatuses={filterStatuses}
        onToggleStatus={(s) => toggleIn(setFilterStatuses, s)}
        coveragePercent={coveragePercent}
        onCoverage={() => setTab("coverage")}
      />
      <ViewTabs tab={tab} onTab={setTab} coveragePercent={coveragePercent} hasCoverage={Boolean(state.coverage)} />
      {tab === "coverage"
        ? <CoverageView coverage={state.coverage} hint={state.coverageHint} />
        : (
          <>
            <Toolbar
              visible={all.length > 0}
              searchText={searchText}
              onSearch={setSearchText}
              jumpDisabled={jumper.failingCount === 0}
              onJump={() => jumper.jump(1)}
              groupBy={groupBy}
              onGroupBy={setGroupBy}
              sortBy={sortBy}
              onSortBy={setSortBy}
              showingText={showingText}
            />
            <ResultsList
              total={all.length}
              view={view}
              groups={groups}
              groupBy={groupBy}
              collapsedGroups={collapsedGroups}
              expandedRows={expandedRows}
              expandedSecondary={expandedSecondary}
              onToggleGroup={(k) => toggleIn(setCollapsedGroups, k)}
              onToggleRow={(k) => toggleIn(setExpandedRows, k)}
              onToggleSecondary={(k) => toggleIn(setExpandedSecondary, k)}
              setRowRef={jumper.setRowRef}
            />
          </>
        )}
    </>
  );
}
