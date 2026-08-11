// The Coverage tab: one row per file, and every file exactly once.
//
// This used to be three lists -- "New code", "Worth covering" and "All files" --
// ordered by how actionable each was. They did not partition the files, they
// overlapped: a changed file containing a large untested block appeared in all
// three, showing a third of its story in each, with nothing on screen saying
// they were the same file. Reading it meant cross-referencing by name.
//
// Now each file states everything at once: its coverage, whether the change set
// touched it, how its changed lines fared, and where its worst untested block
// is. The prioritisation the sections used to express through their order
// survives as the default sort (see rowTier), so the code that most needs a
// test is still what you read first.
//
// A project-wide percentage leads nowhere ("74%" tells nobody what to do), so
// it stays a header stat rather than the headline.

import { useState } from "preact/hooks";
import type { CoveragePayload, CoverageSuggestion } from "../coverage/payload";
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

function Pct({ percent }: { percent: number | null }) {
  return <span class={"cov-pct cov-band-" + bandOf(percent)}>{percent == null ? "\u2014" : percent + "%"}</span>;
}

// One file: its numbers, its tags, its note, and its source when opened.
function FileRow({ row, expanded, onToggle }: {
  row: CoverageRow;
  expanded: boolean;
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
        {!row.measured && <span class="cov-tag cov-tag-unmeasured" title="the coverage report never mentions this file">not measured</span>}
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
        ? <SourceView path={row.path} />
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
// rather than any one file -- including how many files no report mentions,
// which the list can only show one row at a time.
function PatchBanner({ coverage }: { coverage: CoveragePayload }) {
  const [asked, setAsked] = useState<"idle" | "sent" | "error">("idle");
  const patch = coverage.patch;
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

  // Unmeasured files are not "clean": nothing observed them, so the green state
  // would be claiming a result the report cannot support.
  const clean = patch.total > 0 && patch.covered === patch.total && patch.unmeasuredFiles === 0;
  const onAsk = async () => {
    const ok = await askAgentCoverage("patch");
    setAsked(ok ? "sent" : "error");
  };

  return (
    <div class="cov-patch" data-testid="coverage-patch">
      <div class={"cov-patch-head" + (clean ? " ok" : " warn")}>
        <span class="cov-patch-label">New code</span>
        <span data-testid="patch-headline">{patchHeadline(coverage)}</span>
        <span class="cov-spacer" />
        <Bar percent={patch.percent} testid="patch-bar" />
        <Pct percent={patch.percent} />
      </div>
      <p class="cov-note">
        Compared against {patch.against}. Counts added lines in measured source files only &mdash;
        deleted lines, build output, tests and docs are excluded, so this is smaller than the raw diff.
      </p>
      {!clean && (
        <button
          type="button"
          class={"ask-btn" + (asked === "sent" ? " ask-sent" : asked === "error" ? " ask-error" : "")}
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

export function CoverageView({ coverage, hint }: { coverage: CoveragePayload | null; hint: CoverageSuggestion | null }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<CoverageSort>("actionable");

  if (!coverage) return <CoverageEmpty hint={hint} />;

  // Keyed by path, which is now enough: one row per file means a path
  // identifies a row again. It did not when the same file appeared in three
  // lists, and a shared key made every copy open and close together.
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
              onToggle={() => toggleRow(r.path)}
            />
          ))}
      </section>
    </div>
  );
}
