// Results area: the empty states, the flat list, and the grouped list with
// collapsible group headers.
import type { Row, GroupBy } from "./format";
import type { Counts, Group } from "./derive";
import { TestRow } from "./TestRow";

function MiniCounts({ c }: { c: Counts }) {
  return (
    <>
      {c.pass > 0 && <span class="mini mini-pass">{c.pass} passed</span>}
      {c.fail > 0 && <span class="mini mini-fail">{c.fail} failed</span>}
      {c.skip > 0 && <span class="mini mini-skip">{c.skip} skipped</span>}
    </>
  );
}

export interface ResultsListProps {
  total: number;
  view: Row[];
  groups: Group[];
  groupBy: GroupBy;
  collapsedGroups: Set<string>;
  expandedRows: Set<string>;
  expandedSecondary: Set<string>;
  onToggleGroup: (key: string) => void;
  onToggleRow: (key: string) => void;
  onToggleSecondary: (key: string) => void;
  setRowRef: (i: number) => (el: HTMLElement | null) => void;
}

export function ResultsList(props: ResultsListProps) {
  const { total, view, groups, groupBy, collapsedGroups, expandedRows, expandedSecondary } = props;

  const renderRow = (x: Row) => (
    <TestRow
      key={x.k}
      t={x.t}
      index={x.i}
      expanded={expandedRows.has(x.k)}
      secondaryOpen={expandedSecondary.has(x.k)}
      onToggle={() => props.onToggleRow(x.k)}
      onToggleMore={() => props.onToggleSecondary(x.k)}
      innerRef={props.setRowRef(x.i)}
    />
  );

  let content;
  if (total === 0) {
    content = <p class="empty" data-testid="empty">No test results yet. Ask the agent to run tests and report the results!</p>;
  } else if (view.length === 0) {
    content = <p class="empty" data-testid="empty">No tests match the current filter or search.</p>;
  } else if (groupBy === "none") {
    content = view.map(renderRow);
  } else {
    content = groups.map((g) => {
      const collapsed = collapsedGroups.has(g.key);
      return (
        <div class="group" data-testid="group" key={g.key}>
          <div class="group-head" data-testid="group-header" onClick={() => props.onToggleGroup(g.key)}>
            <button class="toggle" type="button" aria-expanded={collapsed ? "false" : "true"} aria-label="Toggle group">{"\u25B6"}</button>
            <span class="group-name" title={g.key}>{g.key}</span>
            <span class="group-counts"><MiniCounts c={g.counts} /></span>
          </div>
          <div class={"group-body" + (collapsed ? " collapsed" : "")} data-testid="group-body">{g.items.map(renderRow)}</div>
        </div>
      );
    });
  }

  return <div id="list" data-testid="list">{content}</div>;
}
