// Keys a test row's expand state so it survives re-renders and live refreshes.
// key = identity + "#" + ordinal:
//   identity = all stable dimensions (framework+storage+suite+class+name), so
//     same-name tests on different targets (net8.0 vs net9.0) never collide.
//   ordinal  = rank of the row among rows sharing an identity (retries/duplicates),
//     fixed by the row's own metadata (occurrenceSig). A live refresh that reorders
//     the payload keeps every ordinal glued to the same row. Unique => "#0". Rows
//     identical in every parsed field share a key (they are indistinguishable).
// Ids aren't used: TRX executionId changes each run; JUnit ids repeat/miss.
// Single source of truth: node tests import this; view.mjs inlines it (ROWKEY_SRC).

const US = "\u001f"; // delimiter that never appears in data

export function rowIdentity(t){
  return [t.framework||"", t.storage||"", t.suite||"", t.className||"", t.name||""].join(US);
}

// Every stable parsed discriminator, so any two distinguishable rows differ here.
export function occurrenceSig(t){
  return [
    t.startTime||"", t.endTime||"", t.durationMs==null?"":String(t.durationMs),
    t.status||"", t.computerName||"", t.method||"", t.adapter||"", t.message||"",
  ].join(US);
}

export function assignRowKeys(results){
  const groups = new Map();
  results.forEach(t => {
    const id = rowIdentity(t);
    let g = groups.get(id);
    if(!g){ g = []; groups.set(id, g); }
    g.push(t);
  });
  groups.forEach((g, id) => {
    if(g.length === 1){ g[0].__rowKey = id + US + "#0"; return; }
    // Rank each row by its metadata signature, so the ordinal is decided by content
    // alone. Rows with the same signature are indistinguishable and share a key.
    const rank = new Map();
    [...new Set(g.map(occurrenceSig))].sort().forEach((sig, i) => rank.set(sig, i));
    g.forEach(t => { t.__rowKey = id + US + "#" + rank.get(occurrenceSig(t)); });
  });
}

export function rowKey(t){
  return t.__rowKey || rowIdentity(t);
}
