// One test row: header, optional failure preview, and the expandable details
// grid (primary fields always, secondary behind "Show more").
import type { TestResult, TestStatus } from "../types";
import { STATUS_WORD, STATUS_LABEL, fmtDur, fmtTime } from "./format";

interface Field {
  k: string;
  v: string;
  full?: boolean;
  mono?: boolean;
  statusColor?: TestStatus;
}

function renderFields(list: Field[]) {
  return list.map((f, idx) => (
    <div class={"field" + (f.full ? " full" : "")} key={idx}>
      <span class="k">{f.k}</span>
      <span class={"v" + (f.mono ? " mono" : "") + (f.statusColor ? " status-" + f.statusColor : "")}>{f.v}</span>
    </div>
  ));
}

export interface RowProps {
  t: TestResult;
  expanded: boolean;
  secondaryOpen: boolean;
  onToggle: () => void;
  onToggleMore: () => void;
  innerRef: (el: HTMLElement | null) => void;
}

export function TestRow({ t, expanded, secondaryOpen, onToggle, onToggleMore, innerRef }: RowProps) {
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
  // Failures lead with the message; everything else leads with the field grid.
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
