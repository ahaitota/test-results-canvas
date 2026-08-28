// Minimal XML helpers shared by the result and coverage parsers. Not a full XML
// parser -- just enough to walk tags in document order, treating comments, CDATA
// and doctypes as opaque, and to read attributes without tripping over a ">"
// inside a quoted value.

export function xmlUnescape(s: unknown): string {
    return String(s ?? "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

// Read one attribute out of a tag's raw attribute text. Accepts both quoting
// styles: Cobertura writers emit double quotes, but hand-edited and
// Python-generated reports use single quotes. That in turn means a quoted value
// may itself contain an attribute-like substring (name="parses time='5s'
// syntax"), so searching for the wanted name directly would find that
// substring. Walk complete name=value pairs left to right instead: consuming
// each whole quoted value puts the text inside it out of reach.
//
// Hand-rolled rather than a regex: every character is visited at most once and
// never revisited, so a malformed tag carrying a long token with no "=" costs
// linear time. A regex pairing a greedy name against a following "=" backtracks
// over that token from every start position, which is quadratic.
export function attr(attrs: string | undefined, name: string): string | undefined {
    const text = String(attrs || "");
    const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
    let i = 0;
    while (i < text.length) {
        while (i < text.length && isSpace(text[i])) i++;
        const keyStart = i;
        while (i < text.length && !isSpace(text[i]) && text[i] !== "=") i++;
        const key = text.slice(keyStart, i);
        while (i < text.length && isSpace(text[i])) i++;
        if (text[i] !== "=") continue; // a bare token, not an attribute
        i++;
        while (i < text.length && isSpace(text[i])) i++;
        const quote = text[i];
        if (quote !== '"' && quote !== "'") continue; // unquoted value: not well-formed
        const valueStart = ++i;
        while (i < text.length && text[i] !== quote) i++;
        const value = text.slice(valueStart, i);
        i++; // step past the closing quote
        if (key === name) return xmlUnescape(value);
    }
    return undefined;
}

// Attribute parsed as a finite number, or undefined.
export function numAttr(attrs: string | undefined, name: string): number | undefined {
    const raw = attr(attrs, name);
    if (raw == null || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

export interface XmlTag {
    name: string;
    attrs: string;
    closing: boolean;
    selfClosing: boolean;
    // Index of "<" and the index just past ">", so callers can slice out the
    // text content between an open tag and its close tag.
    start: number;
    end: number;
}

// Index just past `marker`, or end of string.
function skipPast(text: string, from: number, marker: string): number {
    const idx = text.indexOf(marker, from);
    return idx < 0 ? text.length : idx + marker.length;
}

// Index of the ">" that ends the tag opened at `from`, ignoring any ">" that
// sits inside a quoted attribute value. -1 when the tag is unterminated.
function tagEnd(text: string, from: number): number {
    let quote = "";
    for (let i = from; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) quote = "";
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === ">") return i;
    }
    return -1;
}

const NAME_END = /[\s/>]/;

// Walk every element tag in document order.
export function* scanTags(xml: string): Generator<XmlTag> {
    const text = String(xml || "");
    let i = 0;
    while (i < text.length) {
        const lt = text.indexOf("<", i);
        if (lt < 0) return;
        if (text.startsWith("<!--", lt)) {
            i = skipPast(text, lt + 4, "-->");
            continue;
        }
        if (text.startsWith("<![CDATA[", lt)) {
            i = skipPast(text, lt + 9, "]]>");
            continue;
        }
        if (text.startsWith("<?", lt) || text.startsWith("<!", lt)) {
            const gt = text.indexOf(">", lt);
            i = gt < 0 ? text.length : gt + 1;
            continue;
        }
        const closing = text[lt + 1] === "/";
        let j = lt + (closing ? 2 : 1);
        const nameStart = j;
        while (j < text.length && !NAME_END.test(text[j])) j++;
        const name = text.slice(nameStart, j);
        if (!name) {
            i = lt + 1;
            continue;
        }
        const gt = tagEnd(text, j);
        if (gt < 0) return;
        let raw = text.slice(j, gt);
        const selfClosing = raw.trimEnd().endsWith("/");
        if (selfClosing) raw = raw.trimEnd().slice(0, -1);
        yield { name, attrs: raw, closing, selfClosing, start: lt, end: gt + 1 };
        i = gt + 1;
    }
}
