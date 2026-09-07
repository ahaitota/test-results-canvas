// Shared JSON helpers for the JSON/JSONL result parsers.

export type Rec = Record<string, unknown>;

export function rec(value: unknown): Rec | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
}

export function str(from: Rec | undefined, key: string): string | undefined {
    const v = from?.[key];
    return typeof v === "string" && v !== "" ? v : undefined;
}

export function num(from: Rec | undefined, key: string): number | undefined {
    const v = from?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function arr(from: Rec | undefined, key: string): unknown[] {
    const v = from?.[key];
    return Array.isArray(v) ? v : [];
}

// Objects from a JSONL/NDJSON stream. Runners interleave plain text (build
// errors, panics) with their JSON events, so a line that is not an object is
// skipped instead of failing the whole run.
export function jsonLines(text: string): Rec[] {
    const out: Rec[] = [];
    for (const line of String(text || "").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
            const parsed = rec(JSON.parse(trimmed));
            if (parsed) out.push(parsed);
        } catch { /* not an event line */ }
    }
    return out;
}

// Joins the parts of a failure message that a report actually carried.
export function joinMessage(...parts: (string | undefined)[]): string | undefined {
    const text = parts.filter(Boolean).join("\n").trim();
    return text || undefined;
}

// The keys of a JSON object at depth 1, mapped to their value when that value is
// a string. Scanned rather than parsed, so it also works on a truncated head.
//
// Detection needs this because a nested key proves nothing about the document:
// an Allure container carries a `status` inside its `befores`, and Jest's
// --json carries `fullName`/`status` inside `assertionResults`. Only a
// *top-level* field says what the file itself is.
export function topLevelFields(text: string): Map<string, string | null> {
    const out = new Map<string, string | null>();
    const s = String(text || "");
    let depth = 0;
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (ch === '"') {
            const key = readString(s, i);
            if (!key) return out; // unterminated: nothing further is trustworthy
            i = key.end;
            // A string at depth 1 is a key only when a ":" follows it.
            const colon = skipSpace(s, i);
            if (depth !== 1 || s[colon] !== ":") continue;
            const valueAt = skipSpace(s, colon + 1);
            const value = s[valueAt] === '"' ? readString(s, valueAt) : null;
            if (!out.has(key.value)) out.set(key.value, value ? value.value : null);
            i = value ? value.end : valueAt;
            continue;
        }
        if (ch === "{" || ch === "[") depth++;
        if (ch === "}" || ch === "]") depth--;
        i++;
    }
    return out;
}

function skipSpace(s: string, from: number): number {
    let i = from;
    while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
    return i;
}

// The JSON string starting at the quote in `from`, or null when unterminated.
function readString(s: string, from: number): { value: string; end: number } | null {
    let value = "";
    for (let i = from + 1; i < s.length; i++) {
        if (s[i] === "\\") {
            value += s[i + 1] ?? "";
            i++;
            continue;
        }
        if (s[i] === '"') return { value, end: i + 1 };
        value += s[i];
    }
    return null;
}
