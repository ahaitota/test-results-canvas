// View shell for the test-results canvas.
//
// This file owns the page CHROME only: the document head, all CSS, and the mount
// point. The interactive UI is a Preact app bundled to dist/client/app.js and
// loaded via the /client.js route (see server.ts). Status colours live in CSS
// classes keyed off data-theme, so a theme flip needs no re-render.
//
// server.ts imports renderShell statically; in dev, `tsc --watch` rebuilds this
// file and `npm run build:client -- --watch` rebuilds the bundle, and extension.ts
// watches both compiled outputs and reloads every open panel — so UI edits appear
// on the next refresh with no extension reload.
export function renderShell(title, askToken = "") {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  /* Theme tracks the Copilot app. Documented app tokens (create-canvas contract)
     drive the main surface, so the exact palette (incl. Dark Dimmed, high-contrast,
     colorblind) is matched; our hex is the fallback and also sets the undocumented
     colors (success green, attention amber, muted backgrounds) per the resolved
     light/dark tone. data-theme is set from the detected app tone (see theme.ts). */
  :root {
    --fgColor-default: var(--text-color-default, #f0f6fc);
    --fgColor-muted: var(--text-color-muted, #9198a1);
    --fgColor-accent: var(--true-color-blue, #4493f8);
    --fgColor-success: #3fb950;
    --fgColor-attention: #d29922;
    --fgColor-danger: var(--true-color-red, #f85149);
    --bgColor-default: var(--background-color-default, #0d1117);
    --bgColor-muted: #151b23;
    --button-default-bgColor-hover: #262c36;
    --bgColor-inset: #010409;
    --bgColor-accent-muted: var(--true-color-blue-muted, #388bfd1a);
    --bgColor-success-muted: #2ea04326;
    --bgColor-attention-muted: #bb800926;
    --bgColor-danger-muted: var(--true-color-red-muted, #f851491a);
    --borderColor-default: var(--border-color-default, #3d444d);
    --borderColor-muted: #3d444db3;
    /* Coverage owns a blue/orange scale of its own. Green and red are reserved
       for test outcome: sharing them made an uncovered line shout as loudly as
       a failing test, and put both colours in one box on the New code banner.
       The blue tracks the accent token, so only the orange needs a per-theme value. */
    --covColor-covered: var(--fgColor-accent);
    --covColor-partial: var(--fgColor-attention);
    --covColor-uncovered: #db6d28;
    --covBgColor-covered-muted: var(--bgColor-accent-muted);
    --covBgColor-uncovered-muted: #db6d2826;
    --fontStack-sans: -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji";
    --fontStack-mono: ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  }
  html[data-theme="light"] {
    --fgColor-default: var(--text-color-default, #1f2328);
    --fgColor-muted: var(--text-color-muted, #59636e);
    --fgColor-accent: var(--true-color-blue, #0969da);
    --fgColor-success: #1a7f37;
    --fgColor-attention: #9a6700;
    --fgColor-danger: var(--true-color-red, #d1242f);
    --bgColor-default: var(--background-color-default, #ffffff);
    --bgColor-muted: #f6f8fa;
    --button-default-bgColor-hover: #eff2f5;
    --bgColor-inset: #f6f8fa;
    --bgColor-accent-muted: var(--true-color-blue-muted, #ddf4ff);
    --bgColor-success-muted: #dafbe1;
    --bgColor-attention-muted: #fff8c5;
    --bgColor-danger-muted: var(--true-color-red-muted, #ffebe9);
    --borderColor-default: var(--border-color-default, #d1d9e0);
    --borderColor-muted: #d1d9e0b3;
    --covColor-uncovered: #bc4c00;
    --covBgColor-uncovered-muted: #fff1e5;
  }
  html, body { transition: background-color .15s ease, color .15s ease; }
  body { font-family:var(--fontStack-sans);
         padding:24px; max-width:1080px; margin:0 auto;
         background:var(--bgColor-default); color:var(--fgColor-default); }
  h1 { font-size:22px; margin-bottom:4px; color:var(--fgColor-default); font-weight:600; }
  hr { border:none; border-top:1px solid var(--borderColor-default); margin:12px 0 4px; }
  .banner { font-weight:600; font-size:14px; margin:0 0 4px; }
  .banner.fail { color:var(--fgColor-danger); }
  .banner.pass { color:var(--fgColor-success); }
  .banner .rate { color:var(--fgColor-muted); font-weight:400; }
  .summary { display:flex; gap:8px; margin:16px 0; flex-wrap:wrap; }
  .summary .brk { flex-basis:100%; height:0; margin:0; }
  .pill { padding:4px 12px; border-radius:999px; font-size:13px; font-weight:600;
          border:1px solid var(--borderColor-muted); }
  /* Status colors are class-based so a theme flip is pure CSS (no re-render). */
  .pill-pass { background:var(--bgColor-success-muted); color:var(--fgColor-success); }
  .pill-fail { background:var(--bgColor-danger-muted); color:var(--fgColor-danger); }
  .pill-skip { background:var(--bgColor-muted); color:var(--fgColor-muted); }
  .pill-total { background:var(--bgColor-accent-muted); color:var(--fgColor-accent); }
  /* A count only earns its colour when it is the run's actual verdict: red on
     "0 failed" reads as a problem on a clean run, and green on "N passed" softens
     one that is failing. The other chip goes quiet. */
  .pill.pill-quiet { background:var(--bgColor-muted); color:var(--fgColor-muted); }
  .row { padding:10px 12px; margin:6px 0 0; border-radius:8px;
         border:1px solid var(--borderColor-default); }
  .row[data-status="pass"] { background:var(--bgColor-success-muted); }
  .row[data-status="fail"] { background:var(--bgColor-danger-muted); }
  .row[data-status="skip"] { background:var(--bgColor-muted); }
  .row-head { display:flex; align-items:center; gap:8px; cursor:pointer; }
  .label { font-weight:600; font-size:11px; letter-spacing:0.5px; flex-shrink:0; }
  .row[data-status="pass"] .label { color:var(--fgColor-success); }
  .row[data-status="fail"] .label { color:var(--fgColor-danger); }
  .row[data-status="skip"] .label { color:var(--fgColor-muted); }
  .name { flex:1; min-width:0; color:var(--fgColor-default);
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dur { color:var(--fgColor-muted); font-size:12px; white-space:nowrap; flex-shrink:0; }
  .toggle { background:none; border:none; cursor:pointer; padding:0 2px; flex-shrink:0;
            color:var(--fgColor-muted); font-size:12px; line-height:1;
            display:inline-flex; align-items:center; transition:transform .12s ease; }
  .toggle:hover { color:var(--fgColor-default); }
  .toggle[aria-expanded="true"] { transform:rotate(90deg); }
  .details { margin-top:8px; padding:14px 16px; background:var(--bgColor-inset);
             border-radius:6px; border:1px solid var(--borderColor-default); }
  .dgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr));
           gap:12px 28px; }
  .field { min-width:0; }
  .field.full { grid-column:1 / -1; }
  .field .k { display:block; font-size:11px; letter-spacing:.5px; text-transform:uppercase;
              color:var(--fgColor-muted); font-weight:600; margin-bottom:3px; }
  .field .v { display:block; font-size:13px; color:var(--fgColor-default); word-break:break-word; }
  .field .v.mono { font-family:var(--fontStack-mono); font-size:12px; }
  .field .v.status-pass { color:var(--fgColor-success); }
  .field .v.status-fail { color:var(--fgColor-danger); }
  .field .v.status-skip { color:var(--fgColor-muted); }
  /* Secondary fields are hidden. */
  .dgrid.secondary { margin-top:14px; padding-top:14px;
                     border-top:1px solid var(--borderColor-muted); }
  .dgrid.secondary.hidden { display:none; }
  .more-toggle { margin-top:12px; font-family:inherit; font-size:12px; font-weight:500;
                 padding:2px 0; background:none; border:none; cursor:pointer;
                 color:var(--fgColor-accent); }
  .more-toggle:hover { text-decoration:underline; }
  .msg { margin-top:12px; padding:8px 10px; background:var(--bgColor-default); border-radius:6px;
         border:1px solid var(--borderColor-default);
         font-family:var(--fontStack-mono); font-size:12px;
         color:var(--fgColor-danger); white-space:pre-wrap; overflow-x:auto; }
  /* When the trace leads (failing tests) drop the top margin and space it from the grid below. */
  .details > .msg:first-child { margin-top:0; margin-bottom:16px; }
  /* Failure headline shown inline under the name, wrapped and clamped to 2 lines. */
  .msg-preview { margin-top:8px; padding:6px 10px; border-radius:6px;
                 background:var(--bgColor-default); border:1px solid var(--borderColor-default);
                 font-family:var(--fontStack-mono); font-size:12px; color:var(--fgColor-danger);
                 white-space:normal; word-break:break-word; cursor:pointer;
                 display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .msg-preview:hover { border-color:var(--fgColor-muted); }
  .empty { color:var(--fgColor-muted); font-style:italic; }
  .controls { display:flex; align-items:center; gap:12px; justify-content:flex-end; }
  .head { margin-top:10px; }
  .head h1 { margin:0; }
  #file-select {
    font-family:var(--fontStack-sans); font-size:13px; font-weight:600;
    padding:6px 10px; border-radius:6px; cursor:pointer;
    max-width:min(42vw, 460px); min-width:0;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    color:var(--fgColor-default); background:var(--bgColor-muted);
    border:1px solid var(--borderColor-default);
  }
  #file-select:hover { border-color:var(--fgColor-muted); }
  /* The file picker fills the row on narrow widths. */
  @media (max-width:520px){
    #file-select { flex:1 1 auto; max-width:none; }
  }
  /* Toolbar: search, group, sort, jump-to-failure */
  .toolbar { display:flex; flex-direction:column; gap:8px; margin:12px 0 6px; }
  .toolbar.hidden { display:none; }
  .toolbar-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .toolbar-controls { gap:16px; }
  /* Group + Sort stay locked together on their own row at any width. */
  .ctl-pair { display:flex; align-items:center; gap:16px; flex-wrap:nowrap; }
  .search { flex:1; min-width:180px; font-family:inherit; font-size:13px;
            padding:6px 10px; border-radius:6px;
            color:var(--fgColor-default); background:var(--bgColor-muted);
            border:1px solid var(--borderColor-default); }
  .search::placeholder { color:var(--fgColor-muted); }
  .search:focus { outline:none; border-color:var(--fgColor-accent); }
  .ctl { font-size:12px; color:var(--fgColor-muted); display:inline-flex; align-items:center; gap:6px; }
  .ctl select { font-family:inherit; font-size:13px; padding:5px 8px; border-radius:6px;
                color:var(--fgColor-default); background:var(--bgColor-muted);
                border:1px solid var(--borderColor-default); cursor:pointer; }
  .ctl select:hover { border-color:var(--fgColor-muted); }
  /* Subtle, low-emphasis link-style button (less weight than the selects). */
  .link-btn { font-family:inherit; font-size:12px; font-weight:500; padding:4px 6px;
              background:none; border:none; border-radius:6px; cursor:pointer;
              color:var(--fgColor-muted); white-space:nowrap; }
  .link-btn:hover:not(:disabled) { color:var(--fgColor-accent); text-decoration:underline; }
  .link-btn:disabled { opacity:.4; cursor:default; }
  .showing { font-size:12px; color:var(--fgColor-muted); margin-left:auto; white-space:nowrap; }
  /* Clickable status filter chips (reuse the summary pills) */
  .summary .pill[data-filter] { cursor:pointer; user-select:none; }
  .summary .pill[data-filter]:hover { border-color:var(--fgColor-muted); }
  .summary.filtering .pill[data-filter]:not(.active) { opacity:.4; }
  .summary .pill[data-filter].active { box-shadow:inset 0 0 0 2px var(--fgColor-accent); }
  /* Group sections */
  /* Margins are top-only and must not collapse through a boundary, or the
     virtual spacers and the real rows disagree on where a row starts. */
  #list { display:flow-root; }
  .vspace { flex-shrink:0; }
  .group { margin:10px 0 0; display:flow-root; }
  .group.continued { margin-top:0; }
  .group-body { display:flow-root; }
  .group-head { display:flex; align-items:center; gap:8px; cursor:pointer;
                padding:6px 4px; border-bottom:1px solid var(--borderColor-muted); }
  .group-name { font-weight:600; font-size:13px; flex:1; min-width:0;
                overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .group-counts { display:flex; gap:6px; flex-shrink:0; }
  .mini { font-size:11px; font-weight:600; padding:1px 8px; border-radius:999px;
          border:1px solid var(--borderColor-muted); }
  .mini-pass { color:var(--fgColor-success); background:var(--bgColor-success-muted); }
  .mini-fail { color:var(--fgColor-danger); background:var(--bgColor-danger-muted); }
  .mini-skip { color:var(--fgColor-muted); background:var(--bgColor-muted); }
  .group-body.collapsed { display:none; }
  /* Jump-to-failure: one smooth scale "bounce" plus a danger color wash that fades. */
  @keyframes jumpFlash {
    0%   { transform: scale(1); }
    50%  { transform: scale(1.02);  background-color: color-mix(in srgb, var(--fgColor-danger) 28%, var(--bgColor-default)); }
    100% { transform: scale(1); }
  }
  .row.flash { animation: jumpFlash .9s ease-in-out; }
  @media (prefers-reduced-motion: reduce){
    .row.flash { animation:none; box-shadow:0 0 0 2px var(--fgColor-accent); }
  }
  .ask-bar { margin: 8px 0 4px; }
  .ask-btn {
    font: inherit; font-size: 12px; cursor: pointer;
    padding: 4px 10px; border-radius: 6px;
    border: 1px solid var(--borderColor-default);
    background: var(--bgColor-muted); color: var(--fgColor-default);
  }
  .ask-btn:hover:not(:disabled) { background: var(--button-default-bgColor-hover, #eff2f5); }
  .ask-btn:disabled { cursor: default; opacity: .7; }
  .ask-btn.ask-sent { color: var(--fgColor-success); border-color: var(--fgColor-success); }
  .ask-btn.ask-error { color: var(--fgColor-danger); border-color: var(--fgColor-danger); }
  /* The same button inside the coverage tab, which keeps green and red out. */
  .ask-btn.ask-cov.ask-sent { color: var(--covColor-covered); border-color: var(--covColor-covered); }
  .ask-btn.ask-cov.ask-error { color: var(--covColor-uncovered); border-color: var(--covColor-uncovered); }

  /* --- Coverage --- */
  .pill-coverage { background:var(--bgColor-accent-muted); color:var(--fgColor-accent); cursor:pointer; }
  .pill-coverage:hover { border-color:var(--fgColor-accent); }
  .view-tabs { display:flex; gap:2px; margin:4px 0 12px; padding:2px;
               border:1px solid var(--borderColor-default); border-radius:8px; width:fit-content; }
  .view-tab { font:inherit; font-size:13px; font-weight:600; cursor:pointer;
              padding:5px 14px; border-radius:6px; border:1px solid transparent;
              background:transparent; color:var(--fgColor-muted); display:flex; gap:6px; align-items:center; }
  .view-tab:hover { color:var(--fgColor-default); background:var(--button-default-bgColor-hover, #eff2f5); }
  .view-tab.active { background:var(--bgColor-muted); color:var(--fgColor-default);
                     border-color:var(--borderColor-muted); }
  .view-tab-badge { font-size:11px; font-weight:600; padding:0 6px; border-radius:999px;
                    background:var(--bgColor-accent-muted); color:var(--fgColor-accent); }

  /* Coverage bands drive both the bar fill and the percentage text, so the
     colour always agrees with the number next to it. */
  .cov-band-high { --cov-color: var(--covColor-covered); }
  .cov-band-medium { --cov-color: var(--covColor-partial); }
  .cov-band-low { --cov-color: var(--covColor-uncovered); }
  .cov-band-none { --cov-color: var(--fgColor-muted); }
  .cov-bar { display:inline-block; width:72px; height:6px; flex-shrink:0;
             border-radius:999px; background:var(--bgColor-muted);
             border:1px solid var(--borderColor-muted); overflow:hidden; }
  .cov-bar-fill { display:block; height:100%; background:var(--cov-color); }
  .cov-pct { font-size:12px; font-weight:600; color:var(--cov-color);
             min-width:38px; text-align:right; flex-shrink:0; }

  .cov-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
              padding:10px 12px; margin-bottom:16px; border-radius:8px;
              border:1px solid var(--borderColor-default); background:var(--bgColor-muted); }
  .cov-headline { display:flex; align-items:baseline; gap:8px; }
  .cov-headline .cov-pct { font-size:22px; min-width:0; }
  .cov-headline-label { font-size:13px; color:var(--fgColor-muted); }
  .cov-meta { font-size:12px; color:var(--fgColor-muted); }
  .cov-spacer { flex:1 1 auto; min-width:8px; }

  .cov-section { margin:0 0 22px; }
  .cov-h { font-size:14px; font-weight:600; margin:0 0 6px; color:var(--fgColor-default); }
  .cov-note { font-size:12px; color:var(--fgColor-muted); margin:4px 0 8px; }
  .cov-lines { font-family:var(--fontStack-mono); }
  .cov-list { display:flex; flex-direction:column; gap:2px; }

  .cov-patch { margin:0 0 16px; }
  /* Neutral whatever the verdict: the bar and percentage inside already carry
     the signal, and a coloured banner here read as a second pass/fail result. */
  .cov-patch-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
                    font-size:13px; font-weight:600; padding:8px 12px; border-radius:6px;
                    border:1px solid var(--borderColor-muted);
                    background:var(--bgColor-muted); color:var(--fgColor-default); }
  .cov-patch-label { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.04em;
                     opacity:.75; flex-shrink:0; }

  /* Filter and sort share a row: both narrow the same single list. */
  .cov-controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:0 0 8px; }
  .cov-sort { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--fgColor-muted); }
  .cov-sort select { font-family:inherit; font-size:12px; padding:4px 6px; border-radius:6px;
                     background:var(--bgColor-default); color:var(--fgColor-default);
                     border:1px solid var(--borderColor-default); }
  .cov-sort select:focus { outline:none; border-color:var(--fgColor-accent); }

  .cov-file { border-bottom:1px solid var(--borderColor-muted); }
  .cov-file-head { display:flex; align-items:center; gap:8px;
                   padding:6px 8px; cursor:pointer; font-size:13px; }
  .cov-file-head:hover { background:var(--bgColor-muted); }
  .cov-file-head.no-source { cursor:default; }
  .cov-file-head.is-test .cov-name { color:var(--fgColor-muted); }
  .cov-caret { color:var(--fgColor-muted); width:10px; flex-shrink:0; }
  .cov-name { font-family:var(--fontStack-mono); min-width:0;
              overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  /* The folder is context, not identity: dimmed so a column of file names stays
     scannable now that the folder tree no longer supplies the grouping. */
  .cov-dir { color:var(--fgColor-muted); }
  .cov-range { font-size:11px; color:var(--fgColor-muted); font-family:var(--fontStack-mono); flex-shrink:0; }
  .cov-counts { font-size:11px; color:var(--fgColor-muted); flex-shrink:0; }
  .cov-unknown { font-style:italic; }
  /* Indented under the row it belongs to, aligned past the caret. */
  .cov-row-note { margin:0 0 6px; padding:0 8px 0 26px; font-size:11px;
                  color:var(--fgColor-muted); font-family:var(--fontStack-mono); }
  .cov-tag { font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.04em;
             padding:1px 6px; border-radius:999px; flex-shrink:0;
             background:var(--bgColor-muted); color:var(--fgColor-muted);
             border:1px solid var(--borderColor-muted); }
  .cov-tag-changed { background:var(--bgColor-accent-muted); color:var(--fgColor-accent); }
  /* "Not measured" stays on the neutral .cov-tag base: it is a gap in the
     report, not a failure, so it should not carry an alarm colour. */

  /* Source view: a fixed-width gutter keeps line numbers and hit counts from
     shifting the code as counts grow. */
  .cov-source { margin:0 0 8px; border-radius:6px; overflow:hidden;
                border:1px solid var(--borderColor-muted); }
  .cov-source-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
                     padding:6px 10px; background:var(--bgColor-muted);
                     font-size:12px; color:var(--fgColor-muted); }
  .cov-source-stat { flex:1 1 auto; }
  .cov-source-msg { padding:8px 10px; font-size:12px; color:var(--fgColor-muted); }
  .cov-code { max-height:420px; overflow:auto; background:var(--bgColor-inset);
              font-family:var(--fontStack-mono); font-size:12px; line-height:1.55; }
  .cov-line { display:flex; align-items:flex-start; white-space:pre; border-left:3px solid transparent; }
  .cov-line.cov-hit { background:var(--covBgColor-covered-muted); border-left-color:var(--covColor-covered); }
  .cov-line.cov-miss { background:var(--covBgColor-uncovered-muted); border-left-color:var(--covColor-uncovered); }
  .cov-line.cov-changed .cov-ln { color:var(--fgColor-accent); font-weight:600; }
  .cov-ln { width:44px; padding-right:8px; text-align:right; flex-shrink:0;
            color:var(--fgColor-muted); user-select:none; }
  .cov-hits { width:40px; padding-right:10px; text-align:right; flex-shrink:0;
              color:var(--fgColor-muted); user-select:none; }
  .cov-line.cov-miss .cov-hits { color:var(--covColor-uncovered); font-weight:600; }
  .cov-text { flex:1 1 auto; padding-right:10px; }

  .cov-empty { padding:20px; border-radius:8px; border:1px dashed var(--borderColor-default);
               background:var(--bgColor-muted); }
  .cov-empty-title { font-size:14px; font-weight:600; margin:0 0 8px; }
  .cov-empty-body { font-size:13px; color:var(--fgColor-muted); margin:0 0 8px; max-width:64ch; }
  .cov-empty-note { font-size:12px; color:var(--fgColor-muted); margin:0 0 12px; }
  .cov-cmd { font-family:var(--fontStack-mono); font-size:12px; margin:0 0 8px;
             padding:8px 10px; border-radius:6px; overflow-x:auto;
             background:var(--bgColor-inset); border:1px solid var(--borderColor-muted); }
</style>
</head>
<body>
  <div id="app"></div>
  <script>window.__INITIAL_TITLE__ = ${JSON.stringify(title)};window.__ASK_TOKEN__ = ${JSON.stringify(askToken)};</script>
  <script type="module" src="/client.js"></script>
</body>
</html>`;
}
//# sourceMappingURL=view.js.map