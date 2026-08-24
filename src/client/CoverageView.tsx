// The Coverage tab: one row per file, and every file exactly once.
//
// Each row states everything about its file at once: its coverage, whether the
// change set touched it, how its changed lines fared, and where its worst
// untested block is. Rows are sorted so the code that most needs a test is what
// you read first (see rowTier). A project-wide percentage leads nowhere, so it
// stays a header stat rather than the headline.

import { useEffect, useState } from "preact/hooks";
import type { CoveragePayload, CoverageSuggestion, CoverageLoadFailure } from "../coverage/model/payload";
import type { CoverageRow, CoverageSort } from "./coverageDerive";
import { bandOf, buildCoverageRows, headlinePercent, headlineTotals, patchHeadline, rowNote } from "./coverageDerive";
import { CoverageEmpty } from "./CoverageEmpty";
import { SourceView } from "./SourceView";
import { askAgentCoverage } from "./askAgent";

// A percentage bar; `null` (nothing executable) renders as an empty track
// rather than a misleading 0%.
function Bar({ percent, testid }: { percent: number | null; testid?: string }) {
  return (
    <span class={"cov-bar cov-band-" + bandOf(percent)} data-testid={testid} title={percent == null ? "no executable lines" : percent + "% covered"}>
      <span class="cov-bar-fill" style={{ width: (percent ?? 0) + "%" }} />
    </span>
  );
}

function Pct({ percent, note }: { percent: number | null; note?: string }) {
  return (
    <span class={"cov-pct cov-band-" + bandOf(percent)}>
      {percent == null ? "\u2014" : percent + "%"}
      {note && <span class="cov-pct-note" data-testid="patch-pct-note">{note}</span>}
    </span>
  );
}

// One file: its numbers, its tags, its note, and its source when opened.
function FileRow({ row, expanded, revision, onToggle }: {
  row: CoverageRow;
  expanded: boolean;
  revision?: number;
  onToggle: () => void;
}) {
  const note = rowNote(row);
  const openable = row.hasSource && row.measured;
  return (
    <div class={"cov-file" + (expanded ? " open" : "")} data-testid="coverage-file" data-path={row.path}>
      <div
        class={"cov-file-head" + (openable ? "" : " no-source") + (row.isTest ? " is-test" : "")}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span class="cov-caret" aria-hidden="true">{expanded ? "\u25BE" : "\u25B8"}</span>
        <span class="cov-name" title={row.path}>
          {row.folder !== "." && <span class="cov-dir">{row.folder}/</span>}
          {row.name}
        </span>
        {row.changed && <span class="cov-tag cov-tag-changed">changed</span>}
        {row.isTest && <span class="cov-tag">test</span>}
        {!row.measured && (
          <span
            class="cov-tag cov-tag-unmeasured"
            title={"Not in the coverage report: the test run never loaded this file.\n"
              + "Usually a different runtime (browser code under a Node runner), another\n"
              + "language, a types-only file with nothing to execute, or an entry point\n"
              + "only production loads.\n"
              + "This is not the same as 0% -- nobody looked, so nothing is known."}
          >
            not measured
          </span>
        )}
        {row.measured && !row.hasSource && <span class="cov-tag" title="the file could not be located on this machine">no source</span>}
        <span class="cov-spacer" />
        {row.measured
          ? (
            <>
              <span class="cov-counts">{row.coveredLines}/{row.totalLines}</span>
              <Bar percent={row.percent} />
              <Pct percent={row.percent} />
            </>
          )
          : <span class="cov-counts cov-unknown">no data</span>}
      </div>
      {note && <p class="cov-row-note" data-testid="coverage-row-note">{note}</p>}
      {expanded && (openable
        ? <SourceView path={row.path} revision={revision} />
        : (
          <div class="cov-source-msg">
            {row.measured
              ? "This file is not on this machine, so only its numbers are available."
              : "The coverage report never mentions this file, so there is nothing to annotate. It changed, and no test observed it."}
          </div>
        ))}
    </div>
  );
}

// The change set's verdict, kept as a banner because it describes the whole run
// rather than any one file.
function PatchBanner({ coverage }: { coverage: CoveragePayload }) {
  const [asked, setAsked] = useState<"idle" | "sent" | "error">("idle");
  const patch = coverage.patch;

  // A new report is a new question. Without this the button stays "Asked the
  // agent", disabled, over numbers it was never asked about.
  useEffect(() => {
    setAsked("idle");
  }, [coverage.revision, patch?.against, patch?.total, patch?.covered]);

  if (!patch) {
    return (
      <div class="cov-patch" data-testid="coverage-patch">
        <div class="cov-patch-head">
          <span class="cov-patch-label">New code</span>
          <span data-testid="patch-headline">No changed source files were detected, so there is nothing new to check.</span>
        </div>
      </div>
    );
  }

  // Unmeasured files are not "clean": nothing observed them, so a pass here
  // would claim a result the report cannot support. Nor are changed lines the
  // report has no entry for, which is what a stale report looks like.
  const unknown = patch.unknownLines ?? 0;
  const clean = patch.total > 0
    && patch.covered === patch.total
    && patch.unmeasuredFiles === 0
    && unknown === 0;
  const onAsk = async () => {
    const ok = await askAgentCoverage("patch");
    setAsked(ok ? "sent" : "error");
  };

  return (
    <div class="cov-patch" data-testid="coverage-patch">
      <div class="cov-patch-head">
        <span class="cov-patch-label">New code</span>
        <span data-testid="patch-headline">{patchHeadline(coverage)}</span>
        <span class="cov-spacer" />
        <Bar percent={patch.percent} testid="patch-bar" />
        <Pct percent={patch.percent} note={unknown > 0 ? "of measured" : undefined} />
      </div>
      <p class="cov-note">
        Compared against {patch.against}. Counts added lines in measured source files only &mdash;
        deleted lines, build output, tests and docs are excluded, so this is smaller than the raw diff.
        {unknown > 0 && ` The percentage covers only the ${patch.total} changed line${patch.total === 1 ? "" : "s"} this report measures; ${unknown} more ${unknown === 1 ? "is" : "are"} outside it, which is what a report taken before the edit looks like.`}
      </p>
      {!clean && (
        <button
          type="button"
          class={"ask-btn ask-cov" + (asked === "sent" ? " ask-sent" : asked === "error" ? " ask-error" : "")}
          data-testid="patch-ask"
          onClick={onAsk}
          disabled={asked === "sent"}
        >
          {asked === "sent" ? "Asked the agent" : asked === "error" ? "Could not reach the agent" : "Ask agent to cover the new code"}
        </button>
      )}
    </div>
  );
}

const SORTS: { key: CoverageSort; label: string; hint: string }[] = [
  { key: "actionable", label: "Most useful to test", hint: "untested new code first, then the biggest gaps" },
  { key: "coverage", label: "Lowest coverage", hint: "by percentage, least covered first" },
  { key: "name", label: "Name", hint: "alphabetical by path" },
];

export function CoverageView({ coverage, hint, error, run }: { coverage: CoveragePayload | null; hint: CoverageSuggestion | null; error: CoverageLoadFailure | null; run?: string }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<CoverageSort>("actionable");

  // Keyed by the run, so switching to another one that also lacks coverage
  // starts from a fresh button rather than the last run's "Asked the agent".
  if (!coverage) return <CoverageEmpty key={run ?? ""} hint={hint} error={error} />;

  // Keyed by path: one row per file, so a path identifies a row.
  const toggleRow = (path: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  const rows = buildCoverageRows(coverage, query, sort);
  const total = buildCoverageRows(coverage, "", sort).length;
  const headline = headlinePercent(coverage);
  const meta = headlineTotals(coverage);

  return (
    <div class="coverage" data-testid="coverage-view">
      <div class="cov-head">
        <span class="cov-headline" data-testid="coverage-headline">
          <Pct percent={headline} />
          <span class="cov-headline-label">of production lines covered</span>
        </span>
        <span class="cov-spacer" />
        <span class="cov-meta" data-testid="coverage-meta">
          {meta.coveredLines}/{meta.totalLines} lines
          {" \u00B7 "}{meta.files} file{meta.files === 1 ? "" : "s"}
          {" \u00B7 "}{coverage.format}
        </span>
      </div>

      <PatchBanner coverage={coverage} />

      <section class="cov-section" data-testid="coverage-files">
        <div class="cov-controls">
          <input
            class="search"
            type="search"
            data-testid="coverage-search"
            placeholder="Filter files…"
            autocomplete="off"
            value={query}
            onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
          />
          <label class="cov-sort">
            <span class="cov-sort-label">Sort</span>
            <select
              data-testid="coverage-sort"
              value={sort}
              onChange={(e) => setSort((e.currentTarget as HTMLSelectElement).value as CoverageSort)}
            >
              {SORTS.map((s) => <option key={s.key} value={s.key} title={s.hint}>{s.label}</option>)}
            </select>
          </label>
        </div>
        {query && <p class="cov-note" data-testid="coverage-showing">Showing {rows.length} of {total} files</p>}
        {rows.length === 0
          ? <p class="cov-note" data-testid="coverage-no-match">No files match that filter.</p>
          : rows.map((r) => (
            <FileRow
              key={r.path}
              row={r}
              expanded={expanded.has(r.path)}
              revision={coverage.revision}
              onToggle={() => toggleRow(r.path)}
            />
          ))}
      </section>
    </div>
  );
}
