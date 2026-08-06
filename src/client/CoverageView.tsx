// The Coverage tab, ordered by how actionable each section is:
//
//   1. New code      -- coverage of the lines that just changed (issue #28 #2)
//   2. Worth covering -- ranked uncovered regions   (issue #28 #3)
//   3. All files      -- the conventional folder tree, for browsing
//
// A project-wide percentage leads nowhere ("74%" tells nobody what to do), so
// it is demoted to a header stat and the change set leads instead.

import { useState } from "preact/hooks";
import type { CoveragePayload, CoverageSuggestion } from "../coverage/payload";
import { bandOf, buildCoverageGroups, baseOf, fmtRanges, headlinePercent, patchHeadline } from "./coverageDerive";
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

// A file row that expands into its annotated source.
function FileRow({ path, percent, covered, total, hasSource, changed, isTest, expanded, onToggle }: {
  path: string;
  percent: number | null;
  covered: number;
  total: number;
  hasSource: boolean;
  changed?: boolean;
  isTest?: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div class={"cov-file" + (expanded ? " open" : "")} data-testid="coverage-file" data-path={path}>
      <div
        class={"cov-file-head" + (hasSource ? "" : " no-source") + (isTest ? " is-test" : "")}
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
        <span class="cov-name" title={path}>{baseOf(path)}</span>
        {changed && <span class="cov-tag cov-tag-changed">changed</span>}
        {isTest && <span class="cov-tag">test</span>}
        {!hasSource && <span class="cov-tag" title="the file could not be located on this machine">no source</span>}
        <span class="cov-spacer" />
        <span class="cov-counts">{covered}/{total}</span>
        <Bar percent={percent} />
        <Pct percent={percent} />
      </div>
      {expanded && (hasSource
        ? <SourceView path={path} />
        : <div class="cov-source-msg">This file is not on this machine, so only its numbers are available.</div>)}
    </div>
  );
}

function PatchSection({ coverage, expanded, onToggleFile }: {
  coverage: CoveragePayload;
  expanded: Set<string>;
  onToggleFile: (p: string) => void;
}) {
  const [asked, setAsked] = useState<"idle" | "sent" | "error">("idle");
  const patch = coverage.patch;
  if (!patch) {
    return (
      <section class="cov-section" data-testid="coverage-patch">
        <h2 class="cov-h">New code</h2>
        <p class="cov-note">No changed source files were detected, so there is nothing new to check.</p>
      </section>
    );
  }

  const clean = patch.total > 0 && patch.covered === patch.total;
  const onAsk = async () => {
    const ok = await askAgentCoverage("patch");
    setAsked(ok ? "sent" : "error");
  };

  return (
    <section class="cov-section" data-testid="coverage-patch">
      <h2 class="cov-h">New code</h2>
      <div class={"cov-patch-head" + (clean ? " ok" : " warn")}>
        <span data-testid="patch-headline">{patchHeadline(coverage)}</span>
        <span class="cov-spacer" />
        <Bar percent={patch.percent} testid="patch-bar" />
        <Pct percent={patch.percent} />
      </div>
      <p class="cov-note">Compared against {patch.against}.</p>
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
      <div class="cov-list">
        {patch.files.map((f) => (
          <div key={f.path} class="cov-patch-file">
            {f.unmeasured
              ? (
                <div class="cov-file-head no-source" data-testid="coverage-file" data-path={f.path}>
                  <span class="cov-name" title={f.path}>{baseOf(f.path)}</span>
                  <span class="cov-tag cov-tag-changed">changed</span>
                  <span class="cov-spacer" />
                  <span class="cov-counts" title="the coverage report never mentions this file">not measured</span>
                </div>
              )
              : (
                <>
                  <FileRow
                    path={f.path}
                    percent={f.percent}
                    covered={f.coveredLines.length}
                    total={f.coveredLines.length + f.uncoveredLines.length}
                    hasSource={Boolean(f.absPath)}
                    changed
                    expanded={expanded.has(f.path)}
                    onToggle={() => onToggleFile(f.path)}
                  />
                  {f.uncoveredLines.length > 0 && !expanded.has(f.path) && (
                    <p class="cov-note cov-lines" data-testid="patch-uncovered-lines">
                      Untested new lines: {fmtRanges(f.uncoveredLines)}
                    </p>
                  )}
                </>
              )}
          </div>
        ))}
      </div>
    </section>
  );
}

function HotspotSection({ coverage, expanded, onToggleFile }: {
  coverage: CoveragePayload;
  expanded: Set<string>;
  onToggleFile: (p: string) => void;
}) {
  const hotspots = coverage.hotspots || [];
  if (!hotspots.length) return null;
  return (
    <section class="cov-section" data-testid="coverage-hotspots">
      <h2 class="cov-h">Worth covering</h2>
      <p class="cov-note">Untested blocks of production code &mdash; code you just changed first, then the largest gaps.</p>
      <div class="cov-list">
        {hotspots.map((h) => {
          const key = h.path + ":" + h.start;
          const open = expanded.has(h.path);
          return (
            <div key={key} class="cov-hotspot" data-testid="coverage-hotspot">
              <div
                class="cov-file-head"
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => onToggleFile(h.path)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onToggleFile(h.path);
                  }
                }}
              >
                <span class="cov-caret" aria-hidden="true">{open ? "\u25BE" : "\u25B8"}</span>
                <span class="cov-name" title={h.path}>{baseOf(h.path)}</span>
                <span class="cov-range">{h.start === h.end ? `line ${h.start}` : `lines ${h.start}\u2013${h.end}`}</span>
                {h.changed && <span class="cov-tag cov-tag-changed">changed</span>}
                {h.wholeFileUncovered && <span class="cov-tag">never run</span>}
                <span class="cov-spacer" />
                <span class="cov-counts">{h.lines} untested</span>
              </div>
              {open && <SourceView path={h.path} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function CoverageView({ coverage, hint }: { coverage: CoveragePayload | null; hint: CoverageSuggestion | null }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (!coverage) return <CoverageEmpty hint={hint} />;

  const toggleFile = (p: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    return next;
  });
  const toggleFolder = (k: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    return next;
  });

  const groups = buildCoverageGroups(coverage.files, query);
  const headline = headlinePercent(coverage);
  const shownFiles = groups.reduce((n, g) => n + g.files.length, 0);

  return (
    <div class="coverage" data-testid="coverage-view">
      <div class="cov-head">
        <span class="cov-headline" data-testid="coverage-headline">
          <Pct percent={headline} />
          <span class="cov-headline-label">of production lines covered</span>
        </span>
        <span class="cov-spacer" />
        <span class="cov-meta" data-testid="coverage-meta">
          {coverage.totals.coveredLines}/{coverage.totals.totalLines} lines
          {" \u00B7 "}{coverage.totals.files} file{coverage.totals.files === 1 ? "" : "s"}
          {" \u00B7 "}{coverage.format}
        </span>
      </div>

      <PatchSection coverage={coverage} expanded={expanded} onToggleFile={toggleFile} />
      <HotspotSection coverage={coverage} expanded={expanded} onToggleFile={toggleFile} />

      <section class="cov-section" data-testid="coverage-files">
        <h2 class="cov-h">All files</h2>
        <input
          class="search"
          type="search"
          data-testid="coverage-search"
          placeholder="Filter files…"
          autocomplete="off"
          value={query}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
        />
        {query && <p class="cov-note" data-testid="coverage-showing">Showing {shownFiles} of {coverage.files.length} files</p>}
        {groups.map((g) => {
          const open = !collapsed.has(g.key);
          return (
            <div key={g.key} class="cov-folder" data-testid="coverage-folder">
              <div
                class="cov-folder-head"
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => toggleFolder(g.key)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleFolder(g.key);
                  }
                }}
              >
                <span class="cov-caret" aria-hidden="true">{open ? "\u25BE" : "\u25B8"}</span>
                <span class="cov-folder-name" title={g.key}>{g.key}</span>
                <span class="cov-spacer" />
                <span class="cov-counts">{g.coveredLines}/{g.totalLines}</span>
                <Bar percent={g.percent} />
                <Pct percent={g.percent} />
              </div>
              {open && g.files.map((f) => (
                <FileRow
                  key={f.path}
                  path={f.path}
                  percent={f.percent}
                  covered={f.coveredLines}
                  total={f.totalLines}
                  hasSource={f.hasSource}
                  changed={f.changed}
                  isTest={f.isTest}
                  expanded={expanded.has(f.path)}
                  onToggle={() => toggleFile(f.path)}
                />
              ))}
            </div>
          );
        })}
      </section>
    </div>
  );
}
