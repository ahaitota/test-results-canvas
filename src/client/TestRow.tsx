// One test row: header, optional failure preview, and the expandable details
// grid (primary fields always, secondary behind "Show more").
import type { TestResult, TestStatus } from "../types";
import { STATUS_WORD, STATUS_LABEL, fmtDur, fmtTime } from "./format";

// One labelled value shown in the details grid, e.g. "Duration" -> "1.2s".
interface TestResultProperty {
  propertyName: string;
  propertyValue: string;
  // Take a whole grid row instead of one ~200px column, for values too long to
  // read when squeezed (fully-qualified class names, adapter URIs).
  spansFullWidth?: boolean;
  // Render the value in a monospace font.
  mono?: boolean;
  // Tint the value with the pass/fail/skip colour.
  statusColor?: TestStatus;
}

function renderProperties(list: TestResultProperty[]) {
  return list.map((p, idx) => (
    <div class={"field" + (p.spansFullWidth ? " full" : "")} key={idx}>
      <span class="k">{p.propertyName}</span>
      <span class={"v" + (p.mono ? " mono" : "") + (p.statusColor ? " status-" + p.statusColor : "")}>{p.propertyValue}</span>
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
  const primary: TestResultProperty[] = [];
  const secondary: TestResultProperty[] = [];
  const add = (
    list: TestResultProperty[],
    propertyName: string,
    propertyValue: string | undefined | null,
    opts: Partial<TestResultProperty> = {},
  ) => {
    if (propertyValue == null || propertyValue === "") return;
    list.push({ propertyName, propertyValue: String(propertyValue), ...opts });
  };
  add(primary, "Class", t.className, { spansFullWidth: true, mono: true });
  add(primary, "Status", STATUS_WORD[t.status] || t.status, { statusColor: t.status });
  add(primary, "Duration", t.durationMs != null ? fmtDur(t.durationMs) : null);
  add(primary, "Start time", fmtTime(t.startTime));
  add(secondary, "Method", t.method || t.name, { mono: true });
  add(secondary, "Framework", t.framework);
  add(secondary, "End time", fmtTime(t.endTime));
  add(secondary, "Computer", t.computerName);
  add(secondary, "Adapter", t.adapter, { spansFullWidth: true, mono: true });

  const primaryGrid = <div class="dgrid">{renderProperties(primary)}</div>;
  const moreBlock = secondary.length ? (
    <>
      <button class="more-toggle" data-testid="show-more" type="button" aria-expanded={secondaryOpen ? "true" : "false"} onClick={onToggleMore}>
        {secondaryOpen ? "Show less \u25B4" : "Show more \u25BE"}
      </button>
      <div class={"dgrid secondary" + (secondaryOpen ? "" : " hidden")} data-testid="row-secondary">{renderProperties(secondary)}</div>
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
