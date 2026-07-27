// Keys a test row's expand state so it survives re-renders and live refreshes.
// key = identity + "#" + ordinal:
//   identity = all stable dimensions (framework+storage+suite+class+name), so
//     same-name tests on different targets (net8.0 vs net9.0) never collide.
//   ordinal  = position among rows sharing an identity (retries/duplicates),
//     ordered by each row's own metadata (occurrenceSig), NOT array position, so
//     a reordered payload keeps every ordinal on the same row. Unique => "#0".
// Ids aren't used: TRX executionId changes each run; JUnit ids repeat/miss.
// Single source of truth: node tests import this; view.mjs inlines it (ROWKEY_SRC).

const US = "\u001f"; // delimiter that never appears in data

export function rowIdentity(t){
  return [t.framework||"", t.storage||"", t.suite||"", t.className||"", t.name||""].join(US);
}

// Orders rows that share an identity; startTime/endTime are the strongest stamps.
export function occurrenceSig(t){
  return [t.startTime||"", t.endTime||"", t.durationMs==null?"":String(t.durationMs), t.status||"", t.message||""].join(US);
}

export function assignRowKeys(results){
  const groups = new Map();
  results.forEach((t, i) => {
    const id = rowIdentity(t);
    let g = groups.get(id);
    if(!g){ g = []; groups.set(id, g); }
    g.push({ t, i });
  });
  groups.forEach((g, id) => {
    if(g.length === 1){ g[0].t.__rowKey = id + US + "#0"; return; }
    g.sort((a, b) => {
      const sa = occurrenceSig(a.t), sb = occurrenceSig(b.t);
      if(sa < sb) return -1;
      if(sa > sb) return 1;
      return a.i - b.i; // identical rows: stable, and indistinguishable anyway
    });
    g.forEach((e, ord) => { e.t.__rowKey = id + US + "#" + ord; });
  });
}

export function rowKey(t){
  return t.__rowKey || rowIdentity(t);
}
