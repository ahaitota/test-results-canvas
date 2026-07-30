// View layer for the test-results canvas.
//
// This file owns ALL of the UI: layout, CSS, and the client-side render logic.
// server.ts imports renderShell statically; in dev, `tsc --watch` rebuilds this
// file and extension.ts watches the compiled dist/src/view.js and reloads every
// open panel, so UI edits appear on the next refresh — no extension reload needed.
//
// You only need a full extension reload (via the agent or /clear) when you
// change extension.ts itself (actions, schemas, SSE wiring).

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
     light/dark tone. data-theme is set from the detected app tone (see JS). */
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
  .summary { display:flex; gap:8px; margin:16px 0; flex-wrap:wrap; }
  .summary .brk { flex-basis:100%; height:0; margin:0; }
  .pill { padding:4px 12px; border-radius:999px; font-size:13px; font-weight:600;
          border:1px solid var(--borderColor-muted); }
  .row { padding:10px 12px; margin:6px 0; border-radius:8px;
         border:1px solid var(--borderColor-default); }
  .row-head { display:flex; align-items:center; gap:8px; cursor:pointer; }
  .label { font-weight:600; font-size:11px; letter-spacing:0.5px; flex-shrink:0; }
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
  /* Hide the preview once expanded — the full trace shows in details. */
  .row:has(.details:not(.hidden)) .msg-preview { display:none; }
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
  <div class="controls">
    <select id="file-select" data-testid="file-select" title="Choose which results file to display"></select>
  </div>
  <div class="head">
    <h1><span id="title" data-testid="title">${title}</span></h1>
  </div>
  <div id="banner" data-testid="banner"></div>
  <hr>
  <div id="summary" data-testid="summary"></div>
  <div id="toolbar" data-testid="toolbar" class="toolbar hidden">
    <div class="toolbar-row">
      <input id="search" data-testid="search" class="search" type="search" placeholder="Search name, class or message…" autocomplete="off" />
      <button id="jump-fail" data-testid="jump-fail" class="link-btn" type="button" title="Jump to failure (n = next, p = previous)">Next failure ↓</button>
    </div>
    <div class="toolbar-row toolbar-controls">
      <div class="ctl-pair">
        <label class="ctl">Group
          <select id="group-by" data-testid="group-by">
            <option value="none">None</option>
            <option value="status">Status</option>
            <option value="namespace">Namespace</option>
            <option value="class">Class</option>
            <option value="suite">Suite</option>
            <option value="framework">Framework</option>
          </select>
        </label>
        <label class="ctl">Sort
          <select id="sort-by" data-testid="sort-by">
            <option value="default">Default</option>
            <option value="name">Name</option>
            <option value="duration">Duration</option>
            <option value="status">Outcome</option>
          </select>
        </label>
      </div>
      <span id="showing" data-testid="showing" class="showing"></span>
    </div>
  </div>
  <div id="list" data-testid="list"><p class="empty" data-testid="empty">No test results yet. Ask the agent to run tests and report the results!</p></div>

<script>
const css = getComputedStyle(document.documentElement);
const tok = (n) => css.getPropertyValue(n).trim();
// Recomputed per render so tokens follow the active theme.
function meta(){
  return {
    pass: { label:"PASS", color:tok("--fgColor-success"), bg:tok("--bgColor-success-muted") },
    fail: { label:"FAIL", color:tok("--fgColor-danger"),  bg:tok("--bgColor-danger-muted") },
    skip: { label:"SKIP", color:tok("--fgColor-muted"),   bg:tok("--bgColor-muted") },
  };
}
function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

const STATUS_WORD = { pass:"Passed", fail:"Failed", skip:"Skipped" };
function fmtTime(iso){
  if(!iso) return "";
  const mt = /(\\d{4}-\\d{2}-\\d{2})[T ](\\d{2}:\\d{2}:\\d{2})/.exec(String(iso));
  return mt ? mt[1]+" "+mt[2] : String(iso);
}
// Make duration human-readable: keep "ms" for sub-second, switch to
// seconds (1 decimal) up to a minute, then "Nm Ss" beyond a minute.
function fmtDur(ms){
  if(ms==null || !Number.isFinite(Number(ms))) return "";
  const n = Number(ms);
  if(n < 1000) return Math.round(n)+" ms";
  if(n < 60000){
    const s = n/1000;
    return (s < 10 ? s.toFixed(2) : s.toFixed(1)).replace(/\\.?0+$/,"")+" s";
  }
  const totalSec = Math.round(n/1000);
  const m = Math.floor(totalSec/60);
  const s = totalSec % 60;
  return s ? m+"m "+s+"s" : m+"m";
}

// True if the free-text query matches any searchable field of a test.
function matchesSearch(t, q){
  return [t.name, t.className, t.method, t.framework, t.suite, t.computerName, t.message]
    .some(v => v && String(v).toLowerCase().indexOf(q) !== -1);
}

// Namespace = the class name minus its final segment (works for both .NET
// "Ns.Sub.Class" and JUnit "com.example.Class").
function namespaceOf(t){
  const c = t.className || "";
  const i = c.lastIndexOf(".");
  return i > 0 ? c.slice(0, i) : (c || "(no namespace)");
}

function groupKeyOf(t){
  switch(groupBy){
    case "status":    return STATUS_WORD[t.status] || t.status;
    case "namespace": return namespaceOf(t);
    case "class":     return t.className || "(no class)";
    case "suite":     return t.suite || t.className || "(no suite)";
    case "framework": return t.framework || "(no framework)";
    default:          return "";
  }
}

// Sort a [{t,i}] view; ties fall back to original order (i) for stability.
function sortView(view){
  const arr = view.slice();
  if(sortBy === "name"){
    arr.sort((a,b)=> String(a.t.name||"").localeCompare(String(b.t.name||"")) || a.i-b.i);
  } else if(sortBy === "duration"){
    const d = x => (x.t.durationMs==null ? -1 : x.t.durationMs);
    arr.sort((a,b)=> d(b)-d(a) || a.i-b.i);
  } else if(sortBy === "status"){
    const rank = { fail:0, skip:1, pass:2 };
    arr.sort((a,b)=> ((rank[a.t.status]??9)-(rank[b.t.status]??9)) || a.i-b.i);
  } else {
    arr.sort((a,b)=> a.i-b.i);
  }
  return arr;
}

// Compact per-group pass/fail/skip badges shown in a group header.
function miniCounts(c){
  const bits = [];
  if(c.pass) bits.push('<span class="mini" style="color:'+tok("--fgColor-success")+';background:'+tok("--bgColor-success-muted")+';">'+c.pass+' passed</span>');
  if(c.fail) bits.push('<span class="mini" style="color:'+tok("--fgColor-danger")+';background:'+tok("--bgColor-danger-muted")+';">'+c.fail+' failed</span>');
  if(c.skip) bits.push('<span class="mini" style="color:'+tok("--fgColor-muted")+';background:'+tok("--bgColor-muted")+';">'+c.skip+' skipped</span>');
  return bits.join("");
}

// Render one test row (header + collapsible details). M = current theme meta.
function renderRow(t, M){
  const m = M[t.status] || M.skip;
  const dur = t.durationMs!=null ? '<span class="dur">'+fmtDur(t.durationMs)+'</span>' : "";
  const arrow = '<button class="toggle" data-testid="row-toggle" type="button" aria-expanded="false" aria-label="Toggle details">&#9654;</button>';
  const statusWord = STATUS_WORD[t.status] || t.status;

  // Collect whichever fields are present in the real result (from the TRX/JUnit).
  const fields = [];
  const add = (k, v, opts) => {
    if(v==null || v==="") return;
    fields.push({ k, v:String(v), full:!!(opts&&opts.full), mono:!!(opts&&opts.mono),
                  color:(opts&&opts.color)||"", secondary:!!(opts&&opts.secondary) });
  };
  // Primary fields: always shown when a row is expanded.
  add("Class", t.className, { full:true, mono:true });
  add("Status", statusWord, { color:m.color });
  add("Duration", t.durationMs!=null ? fmtDur(t.durationMs) : null);
  add("Start time", fmtTime(t.startTime));
  // Secondary fields: tucked behind "Show more".
  add("Method", t.method || t.name, { mono:true, secondary:true });
  add("Framework", t.framework, { secondary:true });
  add("End time", fmtTime(t.endTime), { secondary:true });
  add("Computer", t.computerName, { secondary:true });
  add("Adapter", t.adapter, { full:true, mono:true, secondary:true });

  const renderFields = (list) => list.map(f=>
    '<div class="field'+(f.full?' full':'')+'">'+
      '<span class="k">'+esc(f.k)+'</span>'+
      '<span class="v'+(f.mono?' mono':'')+'"'+(f.color?' style="color:'+f.color+';"':'')+'>'+esc(f.v)+'</span>'+
    '</div>').join("");
  const primaryFields = fields.filter(f=>!f.secondary);
  const secondaryFields = fields.filter(f=>f.secondary);

  const primaryGrid = '<div class="dgrid">'+renderFields(primaryFields)+'</div>';
  const moreBlock = secondaryFields.length
    ? '<button class="more-toggle" data-testid="show-more" type="button" aria-expanded="false">Show more \u25BE</button>'+
      '<div class="dgrid secondary hidden" data-testid="row-secondary">'+renderFields(secondaryFields)+'</div>'
    : '';
  const msgRow = t.message ? '<div class="msg">'+esc(t.message)+'</div>' : "";

  // Failing rows show the message first; other statuses show the field grid first.
  const detailsInner = t.status==="fail"
    ? msgRow + primaryGrid + moreBlock
    : primaryGrid + moreBlock + msgRow;
  const details = '<div class="details hidden" data-testid="row-details">'+detailsInner+'</div>';

  // Inline failure headline (first line only) under the name; full trace stays in details.
  const preview = (t.status==="fail" && t.message)
    ? '<div class="msg-preview" data-testid="msg-preview" title="Click for full details">'+esc(t.message.split(/\\r?\\n/)[0])+'</div>'
    : "";

  return '<div class="row" data-testid="test-row" data-status="'+t.status+'" style="background:'+m.bg+';">'+
           '<div class="row-head" data-testid="row-header">'+
             '<span class="label" style="color:'+m.color+';">'+m.label+'</span>'+
             '<span class="name" data-testid="test-name" title="'+esc(t.name)+'">'+esc(t.name)+'</span>'+
             dur+
             arrow+
           '</div>'+preview+details+
         '</div>';
}

function updateShowing(shown, totalCount){
  const el = document.getElementById("showing");
  if(el) el.textContent = (shown!==totalCount) ? ("Showing "+shown+" of "+totalCount) : "";
}

function updateJumpButton(view){
  const btn = document.getElementById("jump-fail");
  if(btn) btn.disabled = !view.some(x=>x.t.status==="fail");
  failCursor = -1;
}

// Build the list from the current results + search/filter/sort/group state.
function renderList(){
  const list = document.getElementById("list");
  const all = lastState.results || [];
  const M = meta();
  const q = searchText.trim().toLowerCase();

  let view = all.map((t,i)=>({t,i}));
  if(filterStatuses.size) view = view.filter(x=>filterStatuses.has(x.t.status));
  if(q) view = view.filter(x=>matchesSearch(x.t, q));
  view = sortView(view);

  updateShowing(view.length, all.length);
  updateJumpButton(view);

  if(view.length===0){
    list.innerHTML = '<p class="empty" data-testid="empty">No tests match the current filter or search.</p>';
    return;
  }

  if(groupBy==="none"){
    list.innerHTML = view.map(x=>renderRow(x.t, M)).join("");
    return;
  }

  // Grouped: preserve sorted order within groups; groups appear in first-seen order.
  const groups = new Map();
  for(const x of view){
    const key = groupKeyOf(x.t);
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(x);
  }
  let html = "";
  for(const [key, items] of groups){
    const c = { pass:0, fail:0, skip:0 };
    items.forEach(x=>{ c[x.t.status] = (c[x.t.status]||0)+1; });
    const collapsed = collapsedGroups.has(key);
    html +=
      '<div class="group" data-testid="group">'+
        '<div class="group-head" data-testid="group-header" data-group="'+esc(key)+'">'+
          '<button class="toggle" type="button" aria-expanded="'+(collapsed?"false":"true")+'" aria-label="Toggle group">&#9654;</button>'+
          '<span class="group-name" title="'+esc(key)+'">'+esc(key)+'</span>'+
          '<span class="group-counts">'+miniCounts(c)+'</span>'+
        '</div>'+
        '<div class="group-body'+(collapsed?' collapsed':'')+'" data-testid="group-body">'+
          items.map(x=>renderRow(x.t, M)).join("")+
        '</div>'+
      '</div>';
  }
  list.innerHTML = html;
}

// A clickable pass/fail/skip summary pill that doubles as a status filter.
function filterChip(status, text){
  const colorMap = {
    pass: [tok("--bgColor-success-muted"), tok("--fgColor-success")],
    fail: [tok("--bgColor-danger-muted"),  tok("--fgColor-danger")],
    skip: [tok("--bgColor-muted"),         tok("--fgColor-muted")],
  };
  const cm = colorMap[status];
  return '<span class="pill" data-filter="'+status+'" data-testid="chip-'+status+'" role="button" tabindex="0" '+
         'style="background:'+cm[0]+';color:'+cm[1]+';">'+text+'</span>';
}

function applyFilterChipStyles(){
  const summary = document.getElementById("summary");
  summary.classList.toggle("filtering", filterStatuses.size>0);
  summary.querySelectorAll(".pill[data-filter]").forEach(p=>{
    p.classList.toggle("active", filterStatuses.has(p.getAttribute("data-filter")));
  });
}

function render(state){
  lastState = state;
  document.getElementById("title").textContent = state.title || "Test Results";
  if (state.files) updateFileSelect(state.files, state.file);
  const results = state.results || [];
  const list = document.getElementById("list");
  const summary = document.getElementById("summary");
  const banner = document.getElementById("banner");
  const toolbar = document.getElementById("toolbar");

  if(results.length === 0){
    list.innerHTML = '<p class="empty" data-testid="empty">No test results yet. Ask the agent to run tests and report the results!</p>';
    summary.innerHTML = "";
    summary.className = "summary";
    banner.innerHTML = "";
    if(toolbar) toolbar.classList.add("hidden");
    return;
  }
  if(toolbar) toolbar.classList.remove("hidden");

  const passed = results.filter(t=>t.status==="pass").length;
  const failed = results.filter(t=>t.status==="fail").length;
  const skipped = results.filter(t=>t.status==="skip").length;
  const total = results.reduce((s,t)=>s+(t.durationMs||0),0);
  const executed = passed + failed + skipped;
  const passRate = executed ? Math.round((passed/executed)*100) : null;

  const bannerMsg = failed>0
    ? failed+" of "+results.length+" test"+(results.length===1?"":"s")+" failing"
    : "All "+results.length+" test"+(results.length===1?"":"s")+" passing";
  banner.className = "banner";
  banner.style.color = failed>0 ? tok("--fgColor-danger") : tok("--fgColor-success");
  banner.innerHTML = esc(bannerMsg) + (passRate!=null
    ? ' <span style="color:'+tok("--fgColor-muted")+';font-weight:400;">· '+passRate+'% pass rate</span>'
    : '');

  summary.className = "summary";
  summary.innerHTML =
    filterChip("pass", passed+' passed')+
    filterChip("fail", failed+' failed')+
    filterChip("skip", skipped+' skipped')+
    '<span class="brk"></span>'+
    '<span class="pill" data-testid="total" style="background:'+tok("--bgColor-accent-muted")+';color:'+tok("--fgColor-accent")+';">'+fmtDur(total)+' total</span>';
  applyFilterChipStyles();

  renderList();
}

let lastState = { results: [] };

// UI view-state, persisted across re-renders (SSE pushes, theme changes).
let filterStatuses = new Set();   // active status filters (empty = show all)
let searchText = "";              // free-text query
let groupBy = "suite";            // none|status|namespace|class|suite|framework — default: suite
let sortBy = "status";            // default|name|duration|status — default: outcome (failures first)
let collapsedGroups = new Set();  // group keys the user has collapsed
let failCursor = -1;              // cursor into visible failing rows (jump-to-failure)

// --- Theme: always follows the Copilot app (no manual control) ---
// The host mirrors its theme onto our document (create-canvas contract): root/body
// attrs data-color-mode / data-theme-tone / data-visual-mode plus tokens like
// --background-color-default. We read those to pick light/dark for our own accent
// colors; the surface adopts the app's documented tokens directly (see :root CSS).
const darkMedia = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
// Brightness of a resolved CSS color ("rgb(..)"/"rgba(..)"/"#rrggbb").
// Returns "light" | "dark", or null if unparseable or fully transparent.
function toneFromColor(css){
  if (!css) return null;
  css = ("" + css).trim();
  let r, g, b, a = 1;
  if (css.charAt(0) === "#"){
    let h = css.slice(1);
    if (h.length === 3) h = h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);
    if (h.length < 6) return null;
    r = parseInt(h.slice(0,2),16); g = parseInt(h.slice(2,4),16); b = parseInt(h.slice(4,6),16);
  } else {
    const o = css.indexOf("("), e = css.indexOf(")");
    if (o < 0 || e < 0) return null;
    const p = css.slice(o+1, e).split(",");
    r = parseFloat(p[0]); g = parseFloat(p[1]); b = parseFloat(p[2]);
    if (p.length > 3) a = parseFloat(p[3]);
  }
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  if (!isNaN(a) && a === 0) return null;
  return ((0.2126*r + 0.7152*g + 0.0722*b) / 255) < 0.5 ? "dark" : "light";
}
// Detect the Copilot app's current light/dark tone from the theme contract the
// host mirrors onto our document. Returns "light" | "dark" | null.
function appTone(){
  const el = document.documentElement, bd = document.body;
  const attr = (n) => ("" + (el.getAttribute(n) || (bd && bd.getAttribute(n)) || "")).toLowerCase();
  const mode = attr("data-color-mode");   // "light" | "dark" | "auto"
  if (mode === "light" || mode === "dark") return mode;
  const tone = attr("data-theme-tone");   // resolved tone (documented)
  if (tone === "light" || tone === "dark") return tone;
  const vis = attr("data-visual-mode");   // resolved tone when mode is "auto"
  if (vis === "light" || vis === "dark") return vis;
  if (!bd) return null;
  // Last resort: measure the app-provided background token (covers "auto").
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;top:-9999px;background-color:var(--background-color-default)";
  bd.appendChild(probe);
  const bg = getComputedStyle(probe).backgroundColor;
  bd.removeChild(probe);
  return toneFromColor(bg);
}
function applyAppTheme(){
  // Prefer the app's own tone. If the host contract exposes none, fall back to the
  // OS preference (prefers-color-scheme), and only to dark if that's unavailable.
  const osTone = darkMedia ? (darkMedia.matches ? "dark" : "light") : "dark";
  document.documentElement.setAttribute("data-theme", appTone() || osTone);
  render(lastState);
}
applyAppTheme();
// Follow live app theme changes: the host updates the mirrored attributes/tokens
// when the user switches the app theme.
if (window.MutationObserver){
  const themeObserver = new MutationObserver(applyAppTheme);
  const obsOpt = { attributes: true, attributeFilter: ["data-color-mode","data-theme-tone","data-theme-source","data-visual-mode","data-dark-theme","data-light-theme","class","style"] };
  themeObserver.observe(document.documentElement, obsOpt);
  if (document.body) themeObserver.observe(document.body, obsOpt);
}
// An OS theme flip can change the app's mirrored tokens (when the app syncs with
// the OS) and is also our fallback signal when the host exposes no tone, so
// re-evaluate on change. appTone() still takes precedence when available.
if (darkMedia){
  const reeval = () => applyAppTheme();
  if (darkMedia.addEventListener) darkMedia.addEventListener("change", reeval);
  else if (darkMedia.addListener) darkMedia.addListener(reeval);
}

// --- Results file picker (choose which .trx file this panel displays) ---
const fileSelect = document.getElementById("file-select");
function updateFileSelect(files, current){
  if(!fileSelect || !Array.isArray(files)) return;
  const cur = current || fileSelect.value;
  fileSelect.innerHTML = files.map(f =>
    '<option value="'+esc(f)+'"'+(f===cur?' selected':'')+'>'+esc(f)+'</option>').join("");
  if(cur) fileSelect.value = cur;
}
if (fileSelect){
  fileSelect.addEventListener("change", () => {
    fetch("/load?file=" + encodeURIComponent(fileSelect.value)).catch(()=>{});
  });
  // Refresh the list when opened so newly added files show up.
  fileSelect.addEventListener("focus", () => {
    fetch("/files").then(r=>r.json()).then(d=>updateFileSelect(d.files, d.current)).catch(()=>{});
  });
  fetch("/files").then(r=>r.json()).then(d=>updateFileSelect(d.files, d.current)).catch(()=>{});
}

// --- Toolbar: search, group, sort, jump-to-failure ---
const searchEl = document.getElementById("search");
if(searchEl) searchEl.addEventListener("input", ()=>{ searchText = searchEl.value; renderList(); });
const groupEl = document.getElementById("group-by");
if(groupEl){ groupEl.value = groupBy;   // reflect the default in the dropdown
  groupEl.addEventListener("change", ()=>{ groupBy = groupEl.value; renderList(); }); }
const sortEl = document.getElementById("sort-by");
if(sortEl){ sortEl.value = sortBy;
  sortEl.addEventListener("change", ()=>{ sortBy = sortEl.value; renderList(); }); }
const jumpEl = document.getElementById("jump-fail");
if(jumpEl) jumpEl.addEventListener("click", ()=> jumpToNextFailure(1));

// Cycle through the currently-visible failing rows, scrolling each into view.
function jumpToNextFailure(dir){
  const rows = Array.prototype.slice.call(document.querySelectorAll('#list .row[data-status="fail"]'));
  if(!rows.length) return;
  failCursor = (failCursor + dir + rows.length) % rows.length;
  const row = rows[failCursor];
  // Expand the enclosing group if the target failure is hidden inside a collapsed one.
  const body = row.closest(".group-body");
  if(body && body.classList.contains("collapsed")){
    body.classList.remove("collapsed");
    const head = body.previousElementSibling;
    const tg = head && head.querySelector(".toggle");
    if(tg) tg.setAttribute("aria-expanded","true");
    const key = head && head.getAttribute("data-group");
    if(key) collapsedGroups.delete(key);
  }
  row.scrollIntoView({ behavior:"smooth", block:"center" });
  row.classList.remove("flash");
  void row.offsetWidth; // restart the animation even if the same row is re-picked
  row.classList.add("flash");
  setTimeout(()=>row.classList.remove("flash"), 1100);
}

// Filter by clicking (or Enter/Space on) the pass/fail/skip summary chips.
function toggleFilter(st){
  if(!st) return;
  if(filterStatuses.has(st)) filterStatuses.delete(st); else filterStatuses.add(st);
  applyFilterChipStyles();
  renderList();
}
document.getElementById("summary").addEventListener("click", (e)=>{
  const pill = e.target.closest(".pill[data-filter]");
  if(pill) toggleFilter(pill.getAttribute("data-filter"));
});
document.getElementById("summary").addEventListener("keydown", (e)=>{
  const pill = e.target.closest(".pill[data-filter]");
  if(pill && (e.key==="Enter" || e.key===" ")){ e.preventDefault(); toggleFilter(pill.getAttribute("data-filter")); }
});

// Keyboard: n = next failure, p / N = previous failure (ignored while typing).
document.addEventListener("keydown", (e)=>{
  if(e.metaKey||e.ctrlKey||e.altKey) return;
  const tag = (e.target && e.target.tagName ? e.target.tagName : "").toUpperCase();
  if(tag==="INPUT"||tag==="SELECT"||tag==="TEXTAREA") return;
  if(e.key==="n"){ e.preventDefault(); jumpToNextFailure(1); }
  else if(e.key==="p"){ e.preventDefault(); jumpToNextFailure(-1); }
});

const source = new EventSource("/events");
source.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch {} };
source.addEventListener("reload", () => location.reload());

// Expand/collapse group sections and individual test details.
document.getElementById("list").addEventListener("click", (e) => {
  const gh = e.target.closest(".group-head");
  if(gh){
    const body = gh.nextElementSibling;
    if(body){
      const collapsed = body.classList.toggle("collapsed");
      const tg = gh.querySelector(".toggle");
      if(tg) tg.setAttribute("aria-expanded", collapsed ? "false" : "true");
      const key = gh.getAttribute("data-group");
      if(key){ if(collapsed) collapsedGroups.add(key); else collapsedGroups.delete(key); }
    }
    return;
  }
  const moreBtn = e.target.closest(".more-toggle");
  if(moreBtn){
    const grid = moreBtn.nextElementSibling;
    if(grid && grid.classList.contains("secondary")){
      const hidden = grid.classList.toggle("hidden");
      moreBtn.setAttribute("aria-expanded", hidden ? "false" : "true");
      moreBtn.textContent = hidden ? "Show more \u25BE" : "Show less \u25B4";
    }
    return;
  }
  const head = e.target.closest(".row-head, .msg-preview");
  if (!head) return;
  const row = head.closest(".row");
  const details = row.querySelector(".details");
  if (!details) return;
  const open = details.classList.toggle("hidden") === false;
  const btn = row.querySelector(".toggle");
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
});
</script>
</body>
</html>`;
}
