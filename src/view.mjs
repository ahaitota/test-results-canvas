// View layer for the test-results canvas.
//
// This file owns ALL of the UI: layout, CSS, and the client-side render logic.
// extension.mjs re-imports it fresh (cache-busted) on every page load, so you
// can edit this file, click the canvas's refresh button, and see changes
// instantly — no extension reload needed.
//
// You only need a full extension reload (via the agent or /clear) when you
// change extension.mjs itself (actions, schemas, SSE wiring).

export function renderShell(title) {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  /* GitHub Copilot app theme — Primer tokens (extracted from app.js) */
  /* Dark is the default; [data-theme="light"] overrides it. */
  :root {
    --fgColor-default: #f0f6fc;
    --fgColor-muted: #9198a1;
    --fgColor-accent: #4493f8;
    --fgColor-success: #3fb950;
    --fgColor-attention: #d29922;
    --fgColor-danger: #f85149;
    --bgColor-default: #0d1117;
    --bgColor-muted: #151b23;
    --bgColor-inset: #010409;
    --bgColor-accent-muted: #388bfd1a;
    --bgColor-success-muted: #2ea04326;
    --bgColor-attention-muted: #bb800926;
    --bgColor-danger-muted: #f851491a;
    --borderColor-default: #3d444d;
    --borderColor-muted: #3d444db3;
    --fontStack-sans: -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji";
    --fontStack-mono: ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  }
  html[data-theme="light"] {
    --fgColor-default: #1f2328;
    --fgColor-muted: #59636e;
    --fgColor-accent: #0969da;
    --fgColor-success: #1a7f37;
    --fgColor-attention: #9a6700;
    --fgColor-danger: #d1242f;
    --bgColor-default: #ffffff;
    --bgColor-muted: #f6f8fa;
    --bgColor-inset: #f6f8fa;
    --bgColor-accent-muted: #ddf4ff;
    --bgColor-success-muted: #dafbe1;
    --bgColor-attention-muted: #fff8c5;
    --bgColor-danger-muted: #ffebe9;
    --borderColor-default: #d1d9e0;
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
  /* Theme cycle button: shows current preference (Auto / Light / Dark). */
  #theme-toggle {
    box-sizing:border-box; flex-shrink:0;
    display:inline-flex; align-items:center; gap:6px;
    height:28px; padding:0 10px; cursor:pointer;
    border-radius:999px; background:var(--bgColor-inset);
    border:1px solid var(--borderColor-default);
    color:var(--fgColor-default);
    font-family:var(--fontStack-sans); font-size:12px; font-weight:600;
    transition:background .18s ease, border-color .18s ease;
  }
  #theme-toggle:hover { border-color:var(--fgColor-muted); }
  #theme-toggle .theme-ico { font-size:13px; line-height:1; }
  #theme-toggle .theme-label { line-height:1; }
  #file-select {
    font-family:var(--fontStack-sans); font-size:13px; font-weight:600;
    padding:6px 10px; border-radius:6px; cursor:pointer;
    max-width:min(42vw, 460px); min-width:0;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    color:var(--fgColor-default); background:var(--bgColor-muted);
    border:1px solid var(--borderColor-default);
  }
  #file-select:hover { border-color:var(--fgColor-muted); }
  /* The file picker fills the row, the theme toggle stays pinned to the right. */
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
    <select id="file-select" title="Choose which results file to display"></select>
    <button id="theme-toggle" type="button" aria-label="Theme: auto"><span class="theme-ico">🌗</span><span class="theme-label">Auto</span></button>
  </div>
  <div class="head">
    <h1><span id="title">${title}</span></h1>
  </div>
  <div id="banner"></div>
  <hr>
  <div id="summary"></div>
  <div id="toolbar" class="toolbar hidden">
    <div class="toolbar-row">
      <input id="search" class="search" type="search" placeholder="Search name, class or message…" autocomplete="off" />
      <button id="jump-fail" class="link-btn" type="button" title="Jump to next failure (press n)">Next failure ↓</button>
    </div>
    <div class="toolbar-row toolbar-controls">
      <div class="ctl-pair">
        <label class="ctl">Group
          <select id="group-by">
            <option value="none">None</option>
            <option value="status">Status</option>
            <option value="namespace">Namespace</option>
            <option value="class">Class</option>
            <option value="suite">Suite</option>
            <option value="framework">Framework</option>
          </select>
        </label>
        <label class="ctl">Sort
          <select id="sort-by">
            <option value="default">Default</option>
            <option value="name">Name</option>
            <option value="duration">Duration</option>
            <option value="status">Outcome</option>
          </select>
        </label>
      </div>
      <span id="showing" class="showing"></span>
    </div>
  </div>
  <div id="list"><p class="empty">No test results yet. Ask the agent to run tests and report the results!</p></div>

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
  const arrow = '<button class="toggle" type="button" aria-expanded="false" aria-label="Toggle details">&#9654;</button>';
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
    ? '<button class="more-toggle" type="button" aria-expanded="false">Show more \u25BE</button>'+
      '<div class="dgrid secondary hidden">'+renderFields(secondaryFields)+'</div>'
    : '';
  const msgRow = t.message ? '<div class="msg">'+esc(t.message)+'</div>' : "";

  // Failing tests lead with the trace so it's the first thing you read; other
  // statuses keep the field grid first (they rarely carry a message).
  const detailsInner = t.status==="fail"
    ? msgRow + primaryGrid + moreBlock
    : primaryGrid + moreBlock + msgRow;
  const details = '<div class="details hidden">'+detailsInner+'</div>';

  // Inline failure headline (first line only) under the name; full trace stays in details.
  const preview = (t.status==="fail" && t.message)
    ? '<div class="msg-preview" title="Click for full details">'+esc(t.message.split(/\\r?\\n/)[0])+'</div>'
    : "";

  return '<div class="row" data-status="'+t.status+'" style="background:'+m.bg+';">'+
           '<div class="row-head">'+
             '<span class="label" style="color:'+m.color+';">'+m.label+'</span>'+
             '<span class="name" title="'+esc(t.name)+'">'+esc(t.name)+'</span>'+
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
    list.innerHTML = '<p class="empty">No tests match the current filter or search.</p>';
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
      '<div class="group">'+
        '<div class="group-head" data-group="'+esc(key)+'">'+
          '<button class="toggle" type="button" aria-expanded="'+(collapsed?"false":"true")+'" aria-label="Toggle group">&#9654;</button>'+
          '<span class="group-name" title="'+esc(key)+'">'+esc(key)+'</span>'+
          '<span class="group-counts">'+miniCounts(c)+'</span>'+
        '</div>'+
        '<div class="group-body'+(collapsed?' collapsed':'')+'">'+
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
  return '<span class="pill" data-filter="'+status+'" role="button" tabindex="0" '+
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
    list.innerHTML = '<p class="empty">No test results yet. Ask the agent to run tests and report the results!</p>';
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
    '<span class="pill" style="background:'+tok("--bgColor-accent-muted")+';color:'+tok("--fgColor-accent")+';">'+fmtDur(total)+' total</span>';
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

// --- Theme preference: auto | light | dark (default auto) ---
// "auto" follows the app/OS via prefers-color-scheme, and an app-supplied
// theme if the platform ever provides one (data-host-theme). Explicit
// light/dark override auto. Only the preference is persisted.
const THEME_KEY = "test-results-theme-pref";
const THEME_ORDER = ["auto", "light", "dark"];
const THEME_ICON = { auto: "🌗", light: "☀️", dark: "🌙" };
const THEME_LABEL = { auto: "Auto", light: "Light", dark: "Dark" };
const darkMedia = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
function loadThemePref(){
  const v = localStorage.getItem(THEME_KEY);
  return (v === "auto" || v === "light" || v === "dark") ? v : "auto";
}
function hostTheme(){
  // Future-proofing: prefer an app-supplied theme when present.
  const v = document.documentElement.getAttribute("data-host-theme");
  return (v === "light" || v === "dark") ? v : null;
}
function resolveTheme(pref){
  if (pref === "light" || pref === "dark") return pref;
  return hostTheme() || (darkMedia && darkMedia.matches ? "dark" : "light");
}
let themePref = loadThemePref();
function applyTheme(pref){
  themePref = pref;
  const resolved = resolveTheme(pref);
  document.documentElement.setAttribute("data-theme", resolved);
  const btn = document.getElementById("theme-toggle");
  if (btn){
    const ico = btn.querySelector(".theme-ico");
    const lab = btn.querySelector(".theme-label");
    if (ico) ico.textContent = THEME_ICON[pref];
    if (lab) lab.textContent = THEME_LABEL[pref];
    btn.setAttribute("aria-label", "Theme: " + pref + (pref === "auto" ? " (showing " + resolved + ")" : ""));
    btn.title = "Theme: Auto / Light / Dark — click to cycle";
  }
  render(lastState);
}
applyTheme(themePref);
document.getElementById("theme-toggle").addEventListener("click", () => {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(themePref) + 1) % THEME_ORDER.length];
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});
// In Auto, follow live app/OS theme changes.
if (darkMedia){
  const onSchemeChange = () => { if (themePref === "auto") applyTheme("auto"); };
  if (darkMedia.addEventListener) darkMedia.addEventListener("change", onSchemeChange);
  else if (darkMedia.addListener) darkMedia.addListener(onSchemeChange);
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
  else if(e.key==="p" || e.key==="N"){ e.preventDefault(); jumpToNextFailure(-1); }
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
