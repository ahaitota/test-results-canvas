// The expanded file: real source with a per-line gutter.
//
// Percentages say there is a problem; this says where. Blue = executed (with
// its hit count), orange = executable but never ran, dim = not executable. Lines
// the current diff touched get a marker, so "new and untested" is one glance
// rather than a cross-reference.
//
// Fetched on demand from /source, which only serves files present in the loaded
// report, and rendered as Preact text nodes so hostile source content and
// hostile file paths are escaped rather than parsed.

import { useEffect, useRef, useState } from "preact/hooks";
import type { SourceFileView } from "../coverage/payload";
import { askAgentCoverage } from "./askAgent";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; view: SourceFileView };

export function SourceView({ path }: { path: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [asked, setAsked] = useState<"idle" | "sent" | "error">("idle");
  const firstUncoveredRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoad({ state: "loading" });
    fetch("/source?file=" + encodeURIComponent(path))
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok || !body?.ok) setLoad({ state: "error", message: String(body?.error || "could not load the file") });
        else setLoad({ state: "ok", view: body as SourceFileView });
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: "error", message: "could not load the file" });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Land the reader on the first gap rather than at the top of a 600-line file.
  useEffect(() => {
    firstUncoveredRef.current?.scrollIntoView({ block: "center" });
  }, [load]);

  if (load.state === "loading") return <div class="cov-source-msg" data-testid="source-loading">Loading source…</div>;
  if (load.state === "error") return <div class="cov-source-msg" data-testid="source-error">{load.message}</div>;

  const view = load.view;
  const onAsk = async () => {
    const ok = await askAgentCoverage("file", view.path);
    setAsked(ok ? "sent" : "error");
  };

  return (
    <div class="cov-source" data-testid="source-view">
      <div class="cov-source-head">
        <span class="cov-source-stat">
          {view.coveredLines} of {view.totalLines} lines covered
          {view.percent != null && ` \u00B7 ${view.percent}%`}
        </span>
        {view.firstUncovered != null && (
          <button
            type="button"
            class={"ask-btn ask-cov" + (asked === "sent" ? " ask-sent" : asked === "error" ? " ask-error" : "")}
            data-testid="source-ask"
            onClick={onAsk}
            disabled={asked === "sent"}
          >
            {asked === "sent" ? "Asked the agent" : asked === "error" ? "Could not reach the agent" : "Ask agent to add tests"}
          </button>
        )}
      </div>
      <div class="cov-code" data-testid="source-lines">
        {view.lines.map((l) => {
          const cls = l.hits == null ? "neutral" : l.hits > 0 ? "hit" : "miss";
          const isFirstMiss = l.n === view.firstUncovered;
          return (
            <div
              key={l.n}
              class={"cov-line cov-" + cls + (l.changed ? " cov-changed" : "")}
              data-line={l.n}
              data-cov={cls}
              ref={isFirstMiss ? firstUncoveredRef : undefined}
            >
              <span class="cov-ln">{l.n}</span>
              <span class="cov-hits" title={l.hits == null ? "not executable" : l.hits > 0 ? `executed ${l.hits}\u00D7` : "never executed"}>
                {l.hits == null ? "" : l.hits > 0 ? fmtHits(l.hits) : "0"}
              </span>
              <span class="cov-text">{l.text || "\u00A0"}</span>
            </div>
          );
        })}
      </div>
      {view.truncated && <div class="cov-source-msg">File truncated for display.</div>}
    </div>
  );
}

// Hit counts share a narrow gutter with line numbers, so large ones are
// abbreviated rather than allowed to push the code sideways.
function fmtHits(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1000000) return Math.round(n / 100) / 10 + "k";
  return Math.round(n / 100000) / 10 + "M";
}
