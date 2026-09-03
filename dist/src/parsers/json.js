// Shared JSON helpers for the JSON/JSONL result parsers.
export function rec(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
export function str(from, key) {
    const v = from?.[key];
    return typeof v === "string" && v !== "" ? v : undefined;
}
export function num(from, key) {
    const v = from?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
export function arr(from, key) {
    const v = from?.[key];
    return Array.isArray(v) ? v : [];
}
// Objects from a JSONL/NDJSON stream. Runners interleave plain text (build
// errors, panics) with their JSON events, so a line that is not an object is
// skipped instead of failing the whole run.
export function jsonLines(text) {
    const out = [];
    for (const line of String(text || "").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{"))
            continue;
        try {
            const parsed = rec(JSON.parse(trimmed));
            if (parsed)
                out.push(parsed);
        }
        catch { /* not an event line */ }
    }
    return out;
}
// Joins the parts of a failure message that a report actually carried.
export function joinMessage(...parts) {
    const text = parts.filter(Boolean).join("\n").trim();
    return text || undefined;
}
//# sourceMappingURL=json.js.map