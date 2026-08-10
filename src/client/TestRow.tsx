// One test row: header, optional failure preview, and the expandable details
// grid (primary fields always, secondary behind "Show more").
import type { TestResult, TestStatus } from "../types";
import { useState, useEffect } from "preact/hooks";
import { STATUS_WORD, STATUS_LABEL, fmtDur, fmtTime } from "./format";
import { askAgent } from "./askAgent";

// One labelled value shown in the details grid, e.g. "Duration" -> "1.2s".
interface TestResultPropertyProps {
  name: string;
  value?: string | null;
  // Take a whole grid row instead of one ~200px column, for values too long to
  // read when squeezed (fully-qualified class names, adapter URIs).
  spansFullWidth?: boolean;
  // Render the value in a monospace font.
  mono?: boolean;
  // Tint the value with the pass/fail/skip colour.
  statusColor?: TestStatus;
}

// Renders nothing when the report didn't carry the value.
function TestResultProperty({ name, value, spansFullWidth, mono, statusColor }: TestResultPropertyProps) {
  if (value == null || value === "") return null;
  return (
    <div class={"field" + (spansFullWidth ? " full" : "")}>
      <span class="k">{name}</span>
      <span class={"v" + (mono ? " mono" : "") + (statusColor ? " status-" + statusColor : "")}>{value}</span>
    </div>
  );
}

type AskState = "idle" | "sending" | "sent" | "error";

const ASK_LABEL: Record<AskState, string> = {
  idle: "Ask agent to investigate",
  sending: "Sending\u2026",
  sent: "Sent \u2713",
  error: "Couldn't send \u2014 retry",
};

// Button that asks the agent to look into a failure. The outcome is only ever
// "the message was accepted": the extension can't tell us what the agent does
// with it, so the label never promises more than that.
function AskAgentButton({ index, name }: { index: number; name: string }) {
  const [state, setState] = useState<AskState>("idle");

  // Return to "idle" so the row can be asked about again after a re-run.
  useEffect(() => {
    if (state !== "sent" && state !== "error") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);

  const onClick = async (e: Event) => {
    e.stopPropagation(); // the row header toggles on click; don't collapse the row
    if (state === "sending") return;
    setState("sending");
    setState(await askAgent(index, name) ? "sent" : "error");
  };

  return (
    <div class="ask-bar">
      <button
        class={"ask-btn ask-" + state}
        data-testid="ask-agent"
        data-ask-state={state}
        type="button"
        disabled={state === "sending"}
        onClick={onClick}
      >
        {ASK_LABEL[state]}
      </button>
    </div>
  );
}

export interface RowProps {
  t: TestResult;
  // Position in the payload the server broadcast; identifies the row to /ask.
  index: number;
  expanded: boolean;
  secondaryOpen: boolean;
  onToggle: () => void;
  onToggleMore: () => void;
  innerRef: (el: HTMLElement | null) => void;
}

// Built only while the row is open: it is most of a row's DOM.
function RowDetails({ t, index, secondaryOpen, onToggleMore }: Pick<RowProps, "t" | "index" | "secondaryOpen" | "onToggleMore">) {
  // "Method" falls back to the test name, which every source guarantees, so the
  // panel is populated in practice; the check stops the toggle from ever opening
  // an empty box if that fallback or these fields change.
  const method = t.method || t.name;
  const endTime = fmtTime(t.endTime);
  const hasSecondary = Boolean(method || t.framework || endTime || t.computerName || t.adapter);

  const primaryGrid = (
    <div class="dgrid">
      <TestResultProperty name="Class" value={t.className} spansFullWidth mono />
      <TestResultProperty name="Status" value={STATUS_WORD[t.status] || t.status} statusColor={t.status} />
      <TestResultProperty name="Duration" value={t.durationMs != null ? fmtDur(t.durationMs) : null} />
      <TestResultProperty name="Start time" value={fmtTime(t.startTime)} />
    </div>
  );
  const moreBlock = hasSecondary ? (
    <>
      <button class="more-toggle" data-testid="show-more" type="button" aria-expanded={secondaryOpen ? "true" : "false"} onClick={onToggleMore}>
        {secondaryOpen ? "Show less \u25B4" : "Show more \u25BE"}
      </button>
      <div class={"dgrid secondary" + (secondaryOpen ? "" : " hidden")} data-testid="row-secondary">
        <TestResultProperty name="Method" value={method} mono />
        <TestResultProperty name="Framework" value={t.framework} />
        <TestResultProperty name="End time" value={endTime} />
        <TestResultProperty name="Computer" value={t.computerName} />
        <TestResultProperty name="Adapter" value={t.adapter} spansFullWidth mono />
      </div>
    </>
  ) : null;
  const msgRow = t.message ? <div class="msg">{t.message}</div> : null;
  // Only failures get the button: that's the case worth handing to the agent.
  const askBar = t.status === "fail" ? <AskAgentButton index={index} name={t.name} /> : null;
  // Failures lead with the message; everything else leads with the field grid.
  return (
    <div class="details" data-testid="row-details">
      {t.status === "fail" ? <>{msgRow}{askBar}{primaryGrid}{moreBlock}</> : <>{primaryGrid}{moreBlock}{msgRow}</>}
    </div>
  );
}

export function TestRow({ t, index, expanded, secondaryOpen, onToggle, onToggleMore, innerRef }: RowProps) {
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
      {expanded && <RowDetails t={t} index={index} secondaryOpen={secondaryOpen} onToggleMore={onToggleMore} />}
    </div>
  );
}
