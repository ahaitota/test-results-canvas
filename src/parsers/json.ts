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
