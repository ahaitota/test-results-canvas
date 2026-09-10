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
// The first JSON object a line-delimited stream holds. A head can stop
// mid-line, so an unparseable line is stepped over rather than failing the
// whole read. Detection uses this rather than searching the raw text: a key
// nested inside some other document says nothing about what the document IS.
export function firstJsonObject(text) {
    for (const line of String(text || "").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{"))
            continue;
        try {
            const parsed = rec(JSON.parse(trimmed));
            if (parsed)
                return parsed;
        }
        catch { /* truncated, or not an object */ }
    }
    return undefined;
}
// Objects from a JSONL/NDJSON stream. Runners interleave plain text (build
// errors, panics) with their JSON events, so a line that is not an object is
// skipped -- but a line that *starts* like one and will not parse means the file
// was caught mid-write, and throwing lets the registry reject it rather than
// present the events that happened to be flushed as a complete run.
export function jsonLines(text) {
    const out = [];
    for (const line of String(text || "").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{"))
            continue;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            throw new SyntaxError("truncated JSON event line");
        }
        const record = rec(parsed);
        if (record)
            out.push(record);
    }
    return out;
}
// Joins the parts of a failure message that a report actually carried.
export function joinMessage(...parts) {
    const text = parts.filter(Boolean).join("\n").trim();
    return text || undefined;
}
// Epoch milliseconds as an ISO timestamp. A value outside the range Date can
// represent yields nothing rather than throwing: a timestamp is decoration on
// a row, and must not cost the report it came from.
export function isoFromEpoch(ms) {
    if (ms == null)
        return undefined;
    const at = new Date(ms);
    return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}
// The keys of a JSON object at depth 1, mapped to their value when that value is
// a string. Scanned rather than parsed, so it also works on a truncated head.
//
// Detection needs this because a nested key proves nothing about the document:
// an Allure container carries a `status` inside its `befores`, and Jest's
// --json carries `fullName`/`status` inside `assertionResults`. Only a
// *top-level* field says what the file itself is.
export function topLevelFields(text) {
    const out = new Map();
    const s = String(text || "");
    let depth = 0;
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (ch === '"') {
            const key = readString(s, i);
            if (!key)
                return out; // unterminated: nothing further is trustworthy
            i = key.end;
            // A string at depth 1 is a key only when a ":" follows it.
            const colon = skipSpace(s, i);
            if (depth !== 1 || s[colon] !== ":")
                continue;
            const valueAt = skipSpace(s, colon + 1);
            const value = s[valueAt] === '"' ? readString(s, valueAt) : null;
            if (!out.has(key.value))
                out.set(key.value, value ? value.value : null);
            i = value ? value.end : valueAt;
            continue;
        }
        if (ch === "{" || ch === "[")
            depth++;
        if (ch === "}" || ch === "]")
            depth--;
        i++;
    }
    return out;
}
function skipSpace(s, from) {
    let i = from;
    while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r"))
        i++;
    return i;
}
// The JSON string starting at the quote in `from`, or null when unterminated.
function readString(s, from) {
    let value = "";
    for (let i = from + 1; i < s.length; i++) {
        if (s[i] === "\\") {
            value += s[i + 1] ?? "";
            i++;
            continue;
        }
        if (s[i] === '"')
            return { value, end: i + 1 };
        value += s[i];
    }
    return null;
}
//# sourceMappingURL=json.js.map