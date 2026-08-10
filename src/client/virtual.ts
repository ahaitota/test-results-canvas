// Windowed rendering for the results list.
//
// Headers and rows are flattened into one array in screen order, and only the
// slice intersecting the viewport is rendered; spacer divs stand in for the
// rest. Unrendered items are sized by the last measured height of their size
// class, so a large run never needs to be measured up front.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Row, GroupBy } from "./format";
import type { Group } from "./derive";

// Margins between items, which the measured border box excludes. Must match the
// stylesheet in src/view.ts or the spacers drift.
const ROW_GAP = 6;
const GROUP_GAP = 10;
const DETAIL_GAP = 8;

// Rendered beyond the viewport so a fast scroll never exposes a blank strip.
const OVERSCAN_PX = 800;

// One line of the flattened list.
export type VItem =
  | { kind: "head"; key: string; group: Group }
  | { kind: "row"; key: string; row: Row; groupKey: string };

export interface FlatList {
  items: VItem[];
  // Payload index -> position in `items`, for jumping to an unrendered row.
  rowItemIndex: Map<number, number>;
}

// Flatten the view into screen order.
export function buildItems(
  view: readonly Row[],
  groups: readonly Group[],
  groupBy: GroupBy,
  collapsedGroups: ReadonlySet<string>,
): FlatList {
  const items: VItem[] = [];
  const rowItemIndex = new Map<number, number>();
  const pushRow = (row: Row, groupKey: string) => {
    rowItemIndex.set(row.i, items.length);
    items.push({ kind: "row", key: "r\u001f" + row.k, row, groupKey });
  };

  if (groupBy === "none") {
    for (const row of view) pushRow(row, "");
    return { items, rowItemIndex };
  }
  for (const group of groups) {
    items.push({ kind: "head", key: "g\u001f" + group.key, group });
    if (collapsedGroups.has(group.key)) continue;
    for (const row of group.items) pushRow(row, group.key);
  }
  return { items, rowItemIndex };
}

// Items of the same class have near-identical heights, so one measurement
// estimates the rest.
type SizeClass = "head" | "row" | "preview" | "open";

function sizeClassOf(item: VItem, expandedRows: ReadonlySet<string>): SizeClass {
  if (item.kind === "head") return "head";
  if (expandedRows.has(item.row.k)) return "open";
  return item.row.t.status === "fail" && item.row.t.message ? "preview" : "row";
}

// Used until a class has been measured once.
const INITIAL_ESTIMATES: Record<SizeClass, number> = { head: 34, row: 43, preview: 92, open: 320 };

// What a row would measure with nothing but its header. Taken from any rendered
// row, since a sorted list can show one shape for thousands of rows.
function baseRowHeight(el: HTMLElement): number {
  let extra = 0;
  for (let child = el.firstElementChild?.nextElementSibling; child; child = child.nextElementSibling) {
    extra += (child as HTMLElement).offsetHeight + DETAIL_GAP;
  }
  return el.offsetHeight - extra;
}

// Measurements are cheap to redo, so the map is dropped rather than grown.
const MAX_MEASUREMENTS = 20_000;

// Index of the last item that starts at or before `y`.
function indexAt(offsets: Float64Array, y: number): number {
  let lo = 0;
  let hi = offsets.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface VirtualList {
  // Goes on the element the items are rendered into.
  containerRef: (el: HTMLElement | null) => void;
  // Goes on each rendered item's outer element, by position in `items`.
  itemRef: (index: number) => (el: HTMLElement | null) => void;
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
  // Put the item at `index` in the middle of the viewport.
  scrollToIndex: (index: number) => void;
}

export function useVirtualList(items: readonly VItem[], expandedRows: ReadonlySet<string>): VirtualList {
  const [range, setRange] = useState({ start: 0, end: 0 });
  // Bumped when a measurement changes, to recompute the layout.
  const [version, setVersion] = useState(0);

  const container = useRef<HTMLElement | null>(null);
  const elements = useRef(new Map<number, HTMLElement>());
  const refCache = useRef(new Map<number, (el: HTMLElement | null) => void>());
  const measured = useRef(new Map<string, number>());
  const estimates = useRef({ ...INITIAL_ESTIMATES });
  const seeded = useRef<Record<SizeClass, boolean>>({ head: false, row: false, preview: false, open: false });
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const expandedRef = useRef(expandedRows);
  expandedRef.current = expandedRows;

  // offsets[i] is where item i starts; offsets[n] is the full height.
  const layout = useMemo(() => {
    const n = items.length;
    const offsets = new Float64Array(n + 1);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      offsets[i] = acc;
      const cls = sizeClassOf(items[i], expandedRows);
      acc += measured.current.get(items[i].key + "|" + cls) ?? estimates.current[cls];
    }
    offsets[n] = acc;
    return { offsets, total: acc };
  }, [items, expandedRows, version]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Which slice of the list the viewport is over.
  const updateRange = useCallback(() => {
    const el = container.current;
    if (!el) return;
    const { offsets } = layoutRef.current;
    const count = offsets.length - 1;
    if (count === 0) {
      setRange((prev) => (prev.start === 0 && prev.end === 0 ? prev : { start: 0, end: 0 }));
      return;
    }
    const listTop = el.getBoundingClientRect().top + window.scrollY;
    const viewTop = window.scrollY - listTop - OVERSCAN_PX;
    const viewBottom = window.scrollY + window.innerHeight - listTop + OVERSCAN_PX;
    const start = indexAt(offsets, viewTop);
    const end = Math.min(count, indexAt(offsets, viewBottom) + 1);
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  // Record what rendered items measure, but only where the layout assumed
  // something else, so scrolling through uniform rows costs nothing.
  useLayoutEffect(() => {
    let changed = false;
    for (const [index, el] of elements.current) {
      const item = itemsRef.current[index];
      if (!item) continue;
      const cls = sizeClassOf(item, expandedRef.current);
      const height = el.offsetHeight + (item.kind === "head" ? GROUP_GAP : ROW_GAP);
      if (height <= 0) continue;

      // Every rendered row reveals the plain-row height, whatever its own shape.
      if (item.kind === "row" && !seeded.current.row) {
        const base = baseRowHeight(el) + ROW_GAP;
        if (base > 0) {
          estimates.current.row = base;
          seeded.current.row = true;
          changed = true;
        }
      }

      const key = item.key + "|" + cls;
      const assumed = measured.current.get(key) ?? estimates.current[cls];
      if (Math.abs(assumed - height) < 0.5) continue;
      if (seeded.current[cls]) {
        if (measured.current.size > MAX_MEASUREMENTS) measured.current.clear();
        measured.current.set(key, height);
      } else {
        // First sighting of this shape: it becomes the estimate for the class.
        estimates.current[cls] = height;
        seeded.current[cls] = true;
      }
      changed = true;
    }
    if (changed) setVersion((v) => v + 1);
    else updateRange();
  });

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateRange();
      });
    };
    // A width change invalidates every measurement: text rewraps.
    const onResize = () => {
      measured.current.clear();
      estimates.current = { ...INITIAL_ESTIMATES };
      seeded.current = { head: false, row: false, preview: false, open: false };
      setVersion((v) => v + 1);
      onScroll();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [updateRange]);

  const containerRef = useCallback((el: HTMLElement | null) => {
    container.current = el;
  }, []);

  const itemRef = useCallback((index: number) => {
    let callback = refCache.current.get(index);
    if (!callback) {
      callback = (el: HTMLElement | null) => {
        if (el) elements.current.set(index, el);
        else elements.current.delete(index);
      };
      refCache.current.set(index, callback);
    }
    return callback;
  }, []);

  const scrollToIndex = useCallback((index: number) => {
    const el = container.current;
    const { offsets } = layoutRef.current;
    if (!el || index < 0 || index >= offsets.length - 1) return;
    const listTop = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, listTop + offsets[index] - window.innerHeight / 2) });
    updateRange();
  }, [updateRange]);

  // The range can be a frame behind a payload that shrank the list.
  const count = items.length;
  const start = Math.min(range.start, Math.max(0, count - 1));
  const end = Math.min(Math.max(range.end, start), count);

  return {
    containerRef,
    itemRef,
    start,
    end,
    padTop: layout.offsets[start],
    padBottom: Math.max(0, layout.total - layout.offsets[end]),
    scrollToIndex,
  };
}
