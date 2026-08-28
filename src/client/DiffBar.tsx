// The diff-mode strip: what changed, how many tests it touches, the switch that
// narrows the list, and the button that hands the question to the agent. Hidden
// unless the server has a diff, so a run outside git looks unchanged.
import { useEffect, useState } from "preact/hooks";
import type { DiffPayload } from "../diff/payload";
import { askAgentImpact } from "./askAgent";

type AskState = "idle" | "sending" | "sent" | "error";

const ASK_LABEL: Record<AskState, string> = {
  idle: "Ask agent which tests this affects",
  sending: "Sending\u2026",
  sent: "Sent \u2713",
  error: "Couldn't send \u2014 retry",
};

// Same promise as the row-level button: the extension can tell us the message
// was accepted, never what the agent did with it.
function AskImpactButton() {
  const [state, setState] = useState<AskState>("idle");

  useEffect(() => {
    if (state !== "sent" && state !== "error") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);

  const onClick = async () => {
    if (state === "sending") return;
    setState("sending");
    setState(await askAgentImpact() ? "sent" : "error");
  };

  return (
    <button
      class={"ask-btn ask-" + state}
      data-testid="ask-impact"
      data-ask-state={state}
      type="button"
      disabled={state === "sending"}
      onClick={onClick}
    >
      {ASK_LABEL[state]}
    </button>
  );
}

export interface DiffBarProps {
  diff: DiffPayload | null;
  relevantOnly: boolean;
  onRelevantOnly: (value: boolean) => void;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function DiffBar({ diff, relevantOnly, onRelevantOnly }: DiffBarProps) {
  if (!diff) return null;
  const { counts, changedFiles } = diff;

  // Nothing changed and no history to compare against: say nothing rather than
  // show a row of zeroes.
  if (!changedFiles && !counts.relevant) return null;

  const scope = [
    diff.against,
    changedFiles ? plural(changedFiles, "file") : "",
  ].filter(Boolean).join(" \u00b7 ");

  return (
    <div class="diffbar" data-testid="diffbar">
      <div class="diffbar-row">
        <span class="diff-lead" data-testid="diff-lead">Focus on the tests your current changes affect</span>
        <span class="diff-scope" data-testid="diff-scope" title={diff.files.join("\n")}>Comparing {scope}</span>
      </div>
      <div class="diffbar-row">
        {counts.new > 0 && <span class="rel rel-new" data-testid="count-new">{plural(counts.new, "new test")} added</span>}
        {counts.modified > 0 && <span class="rel rel-modified" data-testid="count-modified">{plural(counts.modified, "test")} you edited</span>}
        {counts.impacted > 0 && <span class="rel rel-impacted" data-testid="count-impacted">{plural(counts.impacted, "test")} may be impacted by your changes</span>}
        {counts.relevant === 0 && <span class="diff-none" data-testid="diff-none">no test in this run matches the change</span>}
      </div>
      <div class="diffbar-row">
        <label class="ctl diff-toggle">
          <input
            type="checkbox"
            data-testid="relevant-only"
            checked={relevantOnly}
            disabled={counts.relevant === 0}
            onChange={(e) => onRelevantOnly((e.currentTarget as HTMLInputElement).checked)}
          />
          Relevant only
        </label>
        {/* Nothing changed on disk means nothing for the agent to read. */}
        {changedFiles > 0 && <AskImpactButton />}
      </div>
    </div>
  );
}
