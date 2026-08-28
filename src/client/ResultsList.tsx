// Results area: the empty states and the windowed list.
//
// Only the slice of the list the viewport is over is rendered, with spacers
// standing in for the rest (see virtual.ts). A group the window opens partway
// through is rendered headless and marked "continued".
import type { VNode } from "preact";
import type { GroupBy } from "./format";
import type { Counts, Group } from "./derive";
import type { VItem, VirtualList } from "./virtual";
import type { RelevanceTags } from "../diff/payload";
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

type Ref = (el: HTMLElement | null) => void;

function composeRefs(a: Ref, b: Ref): Ref {
  return (el) => {
    a(el);
    b(el);
  };
}

export interface ResultsListProps {
  total: number;
  viewCount: number;
  items: VItem[];
  groupBy: GroupBy;
  collapsedGroups: Set<string>;
  expandedRows: Set<string>;
  expandedSecondary: Set<string>;
  // Diff-mode tags for this payload, keyed by the row's payload index. Null
  // when there is no diff to show.
  relevance: RelevanceTags | null;
  onToggleGroup: (key: string) => void;
  onToggleRow: (key: string) => void;
  onToggleSecondary: (key: string) => void;
  setRowRef: (i: number) => Ref;
  virtual: VirtualList;
}

export function ResultsList(props: ResultsListProps) {
  const { total, viewCount, items, groupBy, expandedRows, expandedSecondary, virtual } = props;
  const { start, end, padTop, padBottom } = virtual;

  const renderRow = (item: VItem & { kind: "row" }, index: number) => (
    <TestRow
      key={item.key}
      t={item.row.t}
      index={item.row.i}
      relevance={props.relevance ? props.relevance[item.row.i] : undefined}
      expanded={expandedRows.has(item.row.k)}
      secondaryOpen={expandedSecondary.has(item.row.k)}
      onToggle={() => props.onToggleRow(item.row.k)}
      onToggleMore={() => props.onToggleSecondary(item.row.k)}
      innerRef={composeRefs(virtual.itemRef(index), props.setRowRef(item.row.i))}
    />
  );

  const renderWindow = () => {
    const out: VNode[] = [];
    if (padTop > 0) out.push(<div class="vspace" key="pad-top" aria-hidden="true" style={"height:" + padTop + "px"} />);

    if (groupBy === "none") {
      for (let i = start; i < end; i++) {
        const item = items[i];
        if (item.kind === "row") out.push(renderRow(item, i));
      }
    } else {
      // One container per group the window touches, built as we walk.
      let openKey: string | null = null;
      let openHead: Group | null = null;
      let openHeadIndex = -1;
      let body: VNode[] = [];

      const flush = () => {
        if (openKey === null) return;
        const key = openKey;
        const head = openHead;
        const headIndex = openHeadIndex;
        const collapsed = props.collapsedGroups.has(key);
        out.push(
          <div class={"group" + (head ? "" : " continued")} data-testid="group" key={"g\u001f" + key}>
            {head && (
              <div class="group-head" data-testid="group-header" ref={virtual.itemRef(headIndex)} onClick={() => props.onToggleGroup(key)}>
                <button class="toggle" type="button" aria-expanded={collapsed ? "false" : "true"} aria-label="Toggle group">{"\u25B6"}</button>
                <span class="group-name" title={key}>{key}</span>
                <span class="group-counts"><MiniCounts c={head.counts} /></span>
              </div>
            )}
            <div class={"group-body" + (collapsed ? " collapsed" : "")} data-testid="group-body">{body}</div>
          </div>,
        );
        openKey = null;
        openHead = null;
        openHeadIndex = -1;
        body = [];
      };

      for (let i = start; i < end; i++) {
        const item = items[i];
        if (item.kind === "head") {
          flush();
          openKey = item.group.key;
          openHead = item.group;
          openHeadIndex = i;
        } else {
          // A row whose header is above the window opens a headless container.
          if (openKey !== item.groupKey) {
            flush();
            openKey = item.groupKey;
          }
          body.push(renderRow(item, i));
        }
      }
      flush();
    }

    if (padBottom > 0) out.push(<div class="vspace" key="pad-bottom" aria-hidden="true" style={"height:" + padBottom + "px"} />);
    return out;
  };

  let content;
  if (total === 0) {
    content = <p class="empty" data-testid="empty">No test results yet. Ask the agent to run tests and report the results!</p>;
  } else if (viewCount === 0) {
    content = <p class="empty" data-testid="empty">No tests match the current filter or search.</p>;
  } else {
    content = renderWindow();
  }

  return <div id="list" data-testid="list" ref={virtual.containerRef}>{content}</div>;
}
