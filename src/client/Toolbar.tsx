// Search box, jump-to-failure button, and the grouping/sorting selects.
import { useEffect, useRef, useState } from "preact/hooks";
import type { GroupBy, SortBy } from "./format";
import { GROUP_OPTIONS, SORT_OPTIONS, SEARCH_DEBOUNCE_MS } from "./format";

export interface ToolbarProps {
  visible: boolean;
  searchText: string;
  onSearch: (value: string) => void;
  jumpDisabled: boolean;
  onJump: () => void;
  groupBy: GroupBy;
  onGroupBy: (value: GroupBy) => void;
  canGroupByFile: boolean;
  sortBy: SortBy;
  onSortBy: (value: SortBy) => void;
  showingText: string;
}

export function Toolbar(props: ToolbarProps) {
  // Driven locally so a keystroke only re-renders the toolbar; the list is
  // rebuilt once the typing pauses.
  const [draft, setDraft] = useState(props.searchText);
  const committed = useRef(props.searchText);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Adopt the value only when it changed elsewhere, so a debounce landing
  // mid-word can't rewind what has been typed.
  useEffect(() => {
    if (props.searchText === committed.current) return;
    committed.current = props.searchText;
    setDraft(props.searchText);
  }, [props.searchText]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const onInput = (e: Event) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    setDraft(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      committed.current = value;
      props.onSearch(value);
    }, SEARCH_DEBOUNCE_MS);
  };

  return (
    <div class={"toolbar" + (props.visible ? "" : " hidden")} data-testid="toolbar">
      <div class="toolbar-row">
        <input
          data-testid="search"
          class="search"
          type="search"
          placeholder="Search name, class or message…"
          autocomplete="off"
          value={draft}
          onInput={onInput}
        />
        <button data-testid="jump-fail" class="link-btn" type="button" title="Jump to failure (n = next, p = previous)" disabled={props.jumpDisabled} onClick={props.onJump}>
          Next failure ↓
        </button>
      </div>
      <div class="toolbar-row toolbar-controls">
        <div class="ctl-pair">
          <label class="ctl">Group
            <select data-testid="group-by" value={props.groupBy} onChange={(e) => props.onGroupBy((e.currentTarget as HTMLSelectElement).value as GroupBy)}>
              {GROUP_OPTIONS.filter((o) => o.value !== "file" || props.canGroupByFile)
                .map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label class="ctl">Sort
            <select data-testid="sort-by" value={props.sortBy} onChange={(e) => props.onSortBy((e.currentTarget as HTMLSelectElement).value as SortBy)}>
              {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>
        <span data-testid="showing" class="showing">{props.showingText}</span>
      </div>
    </div>
  );
}
