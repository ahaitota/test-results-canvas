// Search box, jump-to-failure button, and the grouping/sorting selects.
import type { GroupBy, SortBy } from "./format";
import { GROUP_OPTIONS, SORT_OPTIONS } from "./format";

export interface ToolbarProps {
  visible: boolean;
  searchText: string;
  onSearch: (value: string) => void;
  jumpDisabled: boolean;
  onJump: () => void;
  groupBy: GroupBy;
  onGroupBy: (value: GroupBy) => void;
  sortBy: SortBy;
  onSortBy: (value: SortBy) => void;
  showingText: string;
}

export function Toolbar(props: ToolbarProps) {
  return (
    <div class={"toolbar" + (props.visible ? "" : " hidden")} data-testid="toolbar">
      <div class="toolbar-row">
        <input
          data-testid="search"
          class="search"
          type="search"
          placeholder="Search name, class or message…"
          autocomplete="off"
          value={props.searchText}
          onInput={(e) => props.onSearch((e.currentTarget as HTMLInputElement).value)}
        />
        <button data-testid="jump-fail" class="link-btn" type="button" title="Jump to failure (n = next, p = previous)" disabled={props.jumpDisabled} onClick={props.onJump}>
          Next failure ↓
        </button>
      </div>
      <div class="toolbar-row toolbar-controls">
        <div class="ctl-pair">
          <label class="ctl">Group
            <select data-testid="group-by" value={props.groupBy} onChange={(e) => props.onGroupBy((e.currentTarget as HTMLSelectElement).value as GroupBy)}>
              {GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
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
