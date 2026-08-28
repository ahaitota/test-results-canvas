// Merging several results files into one run.
//
// A repo like AITestAgent doesn't produce one TRX — it produces one per test
// project. So the canvas' unit of "a run" is a SET of files, and this is the
// pure half of that: parsed rows in, one tagged list out.
// Concatenate every source's rows, tagging each with the file it came from.
// Sources keep the order given and rows keep file order within a source, so the
// merged list is identical every time it is rebuilt.
export function mergeSources(inputs) {
    const merged = [];
    for (const input of inputs) {
        for (const t of input.results)
            merged.push({ ...t, source: input.source.label });
    }
    return merged;
}
//# sourceMappingURL=sources.js.map