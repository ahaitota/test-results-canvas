// View shell for the test-results canvas.
//
// This file owns the page CHROME only: the document head, all CSS, and the mount
// point. The interactive UI is a Preact app bundled to dist/client/app.js and
// loaded via the /client.js route (see server.ts). Status colours live in CSS
// classes keyed off data-theme, so a theme flip needs no re-render.
//
// server.ts imports renderShell statically; in dev, `tsc --watch` rebuilds this
// file and `build-client --watch` rebuilds the bundle, and extension.ts watches
// both compiled outputs and reloads every open panel — so UI edits appear on the
// next refresh with no extension reload.

export function renderShell(title: string): string {
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
    --bgColor-inset: #010409;
    --bgColor-accent-muted: var(--true-color-blue-muted, #388bfd1a);
    --bgColor-success-muted: #2ea04326;
    --bgColor-attention-muted: #bb800926;
    --bgColor-danger-muted: var(--true-color-red-muted, #f851491a);
    --borderColor-default: var(--border-color-default, #3d444d);
    --borderColor-muted: #3d444db3;
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
    --bgColor-inset: #f6f8fa;
    --bgColor-accent-muted: var(--true-color-blue-muted, #ddf4ff);
    --bgColor-success-muted: #dafbe1;
    --bgColor-attention-muted: #fff8c5;
    --bgColor-danger-muted: var(--true-color-red-muted, #ffebe9);
    --borderColor-default: var(--border-color-default, #d1d9e0);
    --borderColor-muted: #d1d9e0b3;
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
  .row { padding:10px 12px; margin:6px 0; border-radius:8px;
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
  .details.hidden { display:none; }
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
  .group { margin:10px 0; }
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
</style>
</head>
<body>
  <div id="app"></div>
  <script>window.__INITIAL_TITLE__ = ${JSON.stringify(title)};</script>
  <script type="module" src="/client.js"></script>
</body>
</html>`;
}
