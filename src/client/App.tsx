// The Preact app: SSE state, summary/toolbar/list, expansion, filters, grouping,
// jump-to-failure. Behaviour-frozen against the e2e suite (data-testids unchanged).
import { useState, useEffect, useRef } from "preact/hooks";
import type { TestResult, TestStatus } from "../types";
import type { Row } from "./format";
import { STATUS_WORD, STATUS_LABEL, fmtDur, fmtTime, matchesSearch, groupKeyOf, sortView } from "./format";
import { reconcileRowKeys, pruneKeys } from "../rowkey.js";

// What the server pushes over SSE.
interface ServerState {
  title: string;
  results: TestResult[];
  file: string;
  files: string[];
}

// Plus the row keys reconciled for that payload — stored together so a row and its
// key can never come from different payloads.
interface AppState extends ServerState {
  keys: string[];
}

interface Field {
  k: string;
  v: string;
  full?: boolean;
  mono?: boolean;
  statusColor?: TestStatus;
}

const INITIAL_TITLE = (window as unknown as { __INITIAL_TITLE__?: string }).__INITIAL_TITLE__ || "Test Results";

function renderFields(list: Field[]) {
  return list.map((f, idx) => (
    <div class={"field" + (f.full ? " full" : "")} key={idx}>
      <span class="k">{f.k}</span>
      <span class={"v" + (f.mono ? " mono" : "") + (f.statusColor ? " status-" + f.statusColor : "")}>{f.v}</span>
    </div>
  ));
}

interface RowProps {
  t: TestResult;
  expanded: boolean;
  secondaryOpen: boolean;
  onToggle: () => void;
  onToggleMore: () => void;
  innerRef: (el: HTMLElement | null) => void;
}

function TestRow({ t, expanded, secondaryOpen, onToggle, onToggleMore, innerRef }: RowProps) {
  const primary: Field[] = [];
  const secondary: Field[] = [];
  const add = (arr: Field[], k: string, v: string | undefined | null, opts: Partial<Field> = {}) => {
    if (v == null || v === "") return;
    arr.push({ k, v: String(v), ...opts });
  };
  add(primary, "Class", t.className, { full: true, mono: true });
  add(primary, "Status", STATUS_WORD[t.status] || t.status, { statusColor: t.status });
  add(primary, "Duration", t.durationMs != null ? fmtDur(t.durationMs) : null);
  add(primary, "Start time", fmtTime(t.startTime));
  add(secondary, "Method", t.method || t.name, { mono: true });
  add(secondary, "Framework", t.framework);
  add(secondary, "End time", fmtTime(t.endTime));
  add(secondary, "Computer", t.computerName);
  add(secondary, "Adapter", t.adapter, { full: true, mono: true });

  const primaryGrid = <div class="dgrid">{renderFields(primary)}</div>;
  const moreBlock = secondary.length ? (
    <>
      <button class="more-toggle" data-testid="show-more" type="button" aria-expanded={secondaryOpen ? "true" : "false"} onClick={onToggleMore}>
        {secondaryOpen ? "Show less \u25B4" : "Show more \u25BE"}
      </button>
      <div class={"dgrid secondary" + (secondaryOpen ? "" : " hidden")} data-testid="row-secondary">{renderFields(secondary)}</div>
    </>
  ) : null;
  const msgRow = t.message ? <div class="msg">{t.message}</div> : null;
  const detailsInner = t.status === "fail" ? <>{msgRow}{primaryGrid}{moreBlock}</> : <>{primaryGrid}{moreBlock}{msgRow}</>;

  const preview = t.status === "fail" && t.message && !expanded ? (
    <div class="msg-preview" data-testid="msg-preview" title="Click for full details" onClick={onToggle}>
      {t.message.split(/\r?\n/)[0]}
    </div>
  ) : null;

  return (
    <div class="row" data-testid="test-row" data-status={t.status} ref={innerRef}>
      <div class="row-head" data-testid="row-header" onClick={onToggle}>
        <span class="label">{STATUS_LABEL[t.status]}</span>
        <span class="name" data-testid="test-name" title={t.name}>{t.name}</span>
        {t.durationMs != null && <span class="dur">{fmtDur(t.durationMs)}</span>}
        <button class="toggle" data-testid="row-toggle" type="button" aria-expanded={expanded ? "true" : "false"} aria-label="Toggle details">{"\u25B6"}</button>
      </div>
      {preview}
      <div class={"details" + (expanded ? "" : " hidden")} data-testid="row-details">{detailsInner}</div>
    </div>
  );
}

function MiniCounts({ c }: { c: { pass: number; fail: number; skip: number } }) {
  return (
    <>
      {c.pass > 0 && <span class="mini mini-pass">{c.pass} passed</span>}
      {c.fail > 0 && <span class="mini mini-fail">{c.fail} failed</span>}
      {c.skip > 0 && <span class="mini mini-skip">{c.skip} skipped</span>}
    </>
  );
}

export function App() {
  const [state, setState] = useState<AppState>({ title: INITIAL_TITLE, results: [], file: "", files: [], keys: [] });
  const [filterStatuses, setFilterStatuses] = useState<Set<TestStatus>>(new Set());
  const [searchText, setSearchText] = useState("");
  const [groupBy, setGroupBy] = useState("suite");
  const [sortBy, setSortBy] = useState("status");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [expandedSecondary, setExpandedSecondary] = useState<Set<string>>(new Set());
  const [jumpTarget, setJumpTarget] = useState<{ i: number; nonce: number } | null>(null);

  const rowRefs = useRef(new Map<number, HTMLElement>());
  const failingOrderRef = useRef<number[]>([]);
  const rowGroupRef = useRef(new Map<number, string>());
  const failCursor = useRef(-1);
  const jumpNonce = useRef(0);
  const prevPayload = useRef<{ results: TestResult[]; keys: string[] }>({ results: [], keys: [] });
  const keySeq = useRef(new Map<string, number>());

  // Live state stream from the server. Keys are reconciled once per payload, so a
  // row's expansion follows the test itself rather than its position in the array.
  useEffect(() => {
    const source = new EventSource("/events");
    source.onmessage = (e) => {
      let next: ServerState;
      try { next = JSON.parse(e.data); } catch { return; }
      const results = next.results || [];
      const prev = prevPayload.current;
      const { keys, reused } = reconcileRowKeys(results, prev.results, prev.keys, keySeq.current);
      prevPayload.current = { results, keys };
      setState({ ...next, results, keys });
      setExpandedRows((p) => pruneKeys(p, reused));
      setExpandedSecondary((p) => pruneKeys(p, reused));
    };
    source.addEventListener("reload", () => location.reload());
    return () => source.close();
  }, []);

  // The jump cursor restarts whenever the failing set could have changed.
  useEffect(() => { failCursor.current = -1; }, [state.results, groupBy, sortBy, searchText, filterStatuses]);

  const toggleSet = <T,>(setter: (fn: (prev: Set<T>) => Set<T>) => void, key: T) =>
    setter((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

  function jump(dir: number) {
    const order = failingOrderRef.current;
    if (!order.length) return;
    failCursor.current = (failCursor.current + dir + order.length) % order.length;
    const targetI = order[failCursor.current];
    const gk = rowGroupRef.current.get(targetI);
    if (gk && collapsedGroups.has(gk)) {
      setCollapsedGroups((prev) => { const n = new Set(prev); n.delete(gk); return n; });
    }
    setJumpTarget({ i: targetI, nonce: jumpNonce.current++ });
  }
  const jumpRef = useRef(jump);
  jumpRef.current = jump;

  // Scroll the jumped-to row into view and flash it (imperative, like the original).
  useEffect(() => {
    if (!jumpTarget) return;
    const el = rowRefs.current.get(jumpTarget.i);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    const t = setTimeout(() => el.classList.remove("flash"), 1100);
    return () => clearTimeout(t);
  }, [jumpTarget?.nonce]);

  // n = next failure, p = previous (ignored while typing in a control).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = ((e.target as HTMLElement)?.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "n") { e.preventDefault(); jumpRef.current(1); }
      else if (e.key === "p") { e.preventDefault(); jumpRef.current(-1); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const all = state.results || [];
  const passed = all.filter((t) => t.status === "pass").length;
  const failed = all.filter((t) => t.status === "fail").length;
  const skipped = all.filter((t) => t.status === "skip").length;
  const totalDur = all.reduce((s, t) => s + (t.durationMs || 0), 0);
  const executed = passed + failed + skipped;
  const passRate = executed ? Math.round((passed / executed) * 100) : null;

  const q = searchText.trim().toLowerCase();
  let view: Row[] = all.map((t, i) => ({ t, i, k: state.keys[i] }));
  if (filterStatuses.size) view = view.filter((x) => filterStatuses.has(x.t.status));
  if (q) view = view.filter((x) => matchesSearch(x.t, q));
  view = sortView(view, sortBy);

  // Build groups (first-seen order) or a flat list; also the DOM-order failing list.
  const groups: { key: string; items: Row[]; counts: { pass: number; fail: number; skip: number } }[] = [];
  if (groupBy !== "none") {
    const map = new Map<string, Row[]>();
    for (const x of view) {
      const k = groupKeyOf(x.t, groupBy);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(x);
    }
    for (const [key, items] of map) {
      const counts = { pass: 0, fail: 0, skip: 0 };
      items.forEach((x) => { counts[x.t.status]++; });
      groups.push({ key, items, counts });
    }
  }
  const flat = groupBy === "none" ? view : groups.flatMap((g) => g.items);
  failingOrderRef.current = flat.filter((x) => x.t.status === "fail").map((x) => x.i);
  const rg = new Map<number, string>();
  if (groupBy !== "none") for (const g of groups) for (const x of g.items) rg.set(x.i, g.key);
  rowGroupRef.current = rg;

  const setRowRef = (i: number) => (el: HTMLElement | null) => {
    if (el) rowRefs.current.set(i, el); else rowRefs.current.delete(i);
  };
  const renderRow = (x: Row) => (
    <TestRow
      key={x.k}
      t={x.t}
      expanded={expandedRows.has(x.k)}
      secondaryOpen={expandedSecondary.has(x.k)}
      onToggle={() => toggleSet(setExpandedRows, x.k)}
      onToggleMore={() => toggleSet(setExpandedSecondary, x.k)}
      innerRef={setRowRef(x.i)}
    />
  );

  let listContent;
  if (all.length === 0) {
    listContent = <p class="empty" data-testid="empty">No test results yet. Ask the agent to run tests and report the results!</p>;
  } else if (view.length === 0) {
    listContent = <p class="empty" data-testid="empty">No tests match the current filter or search.</p>;
  } else if (groupBy === "none") {
    listContent = view.map(renderRow);
  } else {
    listContent = groups.map((g) => {
      const collapsed = collapsedGroups.has(g.key);
      return (
        <div class="group" data-testid="group" key={g.key}>
          <div class="group-head" data-testid="group-header" onClick={() => toggleSet(setCollapsedGroups, g.key)}>
            <button class="toggle" type="button" aria-expanded={collapsed ? "false" : "true"} aria-label="Toggle group">{"\u25B6"}</button>
            <span class="group-name" title={g.key}>{g.key}</span>
            <span class="group-counts"><MiniCounts c={g.counts} /></span>
          </div>
          <div class={"group-body" + (collapsed ? " collapsed" : "")} data-testid="group-body">{g.items.map(renderRow)}</div>
        </div>
      );
    });
  }

  const bannerMsg = failed > 0
    ? `${failed} of ${all.length} test${all.length === 1 ? "" : "s"} failing`
    : `All ${all.length} test${all.length === 1 ? "" : "s"} passing`;
  const showingText = all.length > 0 && view.length !== all.length ? `Showing ${view.length} of ${all.length}` : "";

  const chip = (status: TestStatus, text: string) => (
    <span
      class={"pill pill-" + status + (filterStatuses.has(status) ? " active" : "")}
      data-filter={status}
      data-testid={"chip-" + status}
      role="button"
      tabIndex={0}
      onClick={() => toggleSet(setFilterStatuses, status)}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSet(setFilterStatuses, status); } }}
    >
      {text}
    </span>
  );

  const onPickFile = (e: Event) => {
    const v = (e.currentTarget as HTMLSelectElement).value;
    setState((s) => ({ ...s, file: v }));
    fetch("/load?file=" + encodeURIComponent(v)).catch(() => {});
  };
  const onFocusFiles = () => {
    fetch("/files").then((r) => r.json()).then((d) => setState((s) => ({ ...s, files: d.files, file: d.current ?? s.file }))).catch(() => {});
  };

  return (
    <>
      <div class="controls">
        <select id="file-select" data-testid="file-select" title="Choose which results file to display" value={state.file} onChange={onPickFile} onFocus={onFocusFiles}>
          {(state.files || []).map((f) => <option value={f} key={f}>{f}</option>)}
        </select>
      </div>
      <div class="head"><h1><span data-testid="title">{state.title || "Test Results"}</span></h1></div>
      <div class={"banner" + (all.length ? (failed > 0 ? " fail" : " pass") : "")} data-testid="banner">
        {all.length > 0 && <>{bannerMsg}{passRate != null && <span class="rate">{" \u00B7 " + passRate + "% pass rate"}</span>}</>}
      </div>
      <hr />
      <div class={"summary" + (filterStatuses.size ? " filtering" : "")} data-testid="summary">
        {all.length > 0 && (
          <>
            {chip("pass", passed + " passed")}
            {chip("fail", failed + " failed")}
            {chip("skip", skipped + " skipped")}
            <span class="brk"></span>
            <span class="pill pill-total" data-testid="total">{fmtDur(totalDur) + " total"}</span>
          </>
        )}
      </div>
      <div class={"toolbar" + (all.length ? "" : " hidden")} data-testid="toolbar">
        <div class="toolbar-row">
          <input
            data-testid="search"
            class="search"
            type="search"
            placeholder="Search name, class or message…"
            autocomplete="off"
            value={searchText}
            onInput={(e) => setSearchText((e.currentTarget as HTMLInputElement).value)}
          />
          <button data-testid="jump-fail" class="link-btn" type="button" title="Jump to failure (n = next, p = previous)" disabled={failingOrderRef.current.length === 0} onClick={() => jump(1)}>
            Next failure ↓
          </button>
        </div>
        <div class="toolbar-row toolbar-controls">
          <div class="ctl-pair">
            <label class="ctl">Group
              <select data-testid="group-by" value={groupBy} onChange={(e) => setGroupBy((e.currentTarget as HTMLSelectElement).value)}>
                <option value="none">None</option>
                <option value="status">Status</option>
                <option value="namespace">Namespace</option>
                <option value="class">Class</option>
                <option value="suite">Suite</option>
                <option value="framework">Framework</option>
              </select>
            </label>
            <label class="ctl">Sort
              <select data-testid="sort-by" value={sortBy} onChange={(e) => setSortBy((e.currentTarget as HTMLSelectElement).value)}>
                <option value="default">Default</option>
                <option value="name">Name</option>
                <option value="duration">Duration</option>
                <option value="status">Outcome</option>
              </select>
            </label>
          </div>
          <span data-testid="showing" class="showing">{showingText}</span>
        </div>
      </div>
      <div id="list" data-testid="list">{listContent}</div>
    </>
  );
}
