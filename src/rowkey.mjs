// Keys a test row's expand state so it survives re-renders and live refreshes.
// key = identity + "#" + ordinal:
//   identity = every STABLE discriminator (framework, storage, suite, class, name,
//     computerName, method, adapter) — fields that don't change when a test reruns.
//     Anchoring keys here keeps expansion glued to a row even when volatile data
//     (timing, duration, status, message) changes between runs.
//   ordinal  = only separates rows identical in every stable field (genuine
//     same-machine retries). Those are ranked by their volatile metadata
//     (occurrenceSig) so the numbering follows content, not payload order; rows
//     identical there too share a key (indistinguishable). Unique => "#0".
// Ids aren't used: TRX executionId changes each run; JUnit ids repeat/miss.
// Single source of truth: node tests import this; view.mjs inlines it (ROWKEY_SRC).

const US = "\u001f"; // delimiter that never appears in data

export function rowIdentity(t){
  return [
    t.framework||"", t.storage||"", t.suite||"", t.className||"", t.name||"",
    t.computerName||"", t.method||"", t.adapter||"",
  ].join(US);
}

// Volatile fields — used only to order genuine retries that share an identity.
export function occurrenceSig(t){
  return [
    t.startTime||"", t.endTime||"", t.durationMs==null?"":String(t.durationMs),
    t.status||"", t.message||"",
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
    // Same stable identity => genuine retries; rank them by volatile metadata so
    // the ordinal follows content. Rows identical here too share a key.
    const rank = new Map();
    [...new Set(g.map(occurrenceSig))].sort().forEach((sig, i) => rank.set(sig, i));
    g.forEach(t => { t.__rowKey = id + US + "#" + rank.get(occurrenceSig(t)); });
  });
}

export function rowKey(t){
  return t.__rowKey || rowIdentity(t);
}
