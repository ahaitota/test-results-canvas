// What the Coverage tab shows when the run produced no coverage report.
//
// This is the state most users hit first, because almost no runner collects
// coverage unless asked. An empty panel would teach them the feature is broken;
// naming the exact command for the project in front of them, with one click to
// have the agent do it, is what turns the tab into something worth opening.

import { useState } from "preact/hooks";
import type { CoverageSuggestion, CoverageLoadFailure } from "../coverage/model/payload";
import { askAgentCoverage } from "./askAgent";

// A report was found but could not be used. The server decides when a reason is
// worth showing -- a file that simply is not a report is an ordinary miss during
// discovery, but a mistake when the caller named it -- so every reason that
// arrives here is displayed.
const FAILURE_TEXT: Record<CoverageLoadFailure, string> = {
  "missing": "The coverage report was named but is no longer on disk.",
  "unreadable": "The coverage report could not be read.",
  "too-large": "The coverage report is too large for this panel to open.",
  "not-coverage": "That file is not a coverage report in any format this panel reads.",
};

export function CoverageEmpty({ hint, error }: { hint: CoverageSuggestion | null; error?: CoverageLoadFailure | null }) {
  const [sent, setSent] = useState<"idle" | "sent" | "error">("idle");
  const failure = error ? FAILURE_TEXT[error] : "";

  const onAsk = async () => {
    const ok = await askAgentCoverage("enable");
    setSent(ok ? "sent" : "error");
  };

  return (
    <div class="cov-empty" data-testid="coverage-empty">
      <p class="cov-empty-title">No coverage data for this run</p>
      {failure
        ? <p class="cov-empty-body" data-testid="coverage-error">{failure}</p>
        : (
          <p class="cov-empty-body">
            A test-results file records which tests ran, not which code they exercised.
            Coverage comes from a separate report written during the same run.
          </p>
        )}
      {hint && (
        <>
          <p class="cov-empty-body">
            For {hint.ecosystem}, re-run the tests with:
          </p>
          <pre class="cov-cmd" data-testid="coverage-command">{hint.command}</pre>
          <p class="cov-empty-note">Writes {hint.outputHint}, which this panel picks up automatically.</p>
        </>
      )}
      <button
        type="button"
        class={"ask-btn ask-cov" + (sent === "sent" ? " ask-sent" : sent === "error" ? " ask-error" : "")}
        data-testid="coverage-ask-enable"
        onClick={onAsk}
        disabled={sent === "sent"}
      >
        {sent === "sent" ? "Asked the agent" : sent === "error" ? "Could not reach the agent" : "Ask agent to re-run with coverage"}
      </button>
    </div>
  );
}
