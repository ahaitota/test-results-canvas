// Minimal XML tag scanner shared by the Cobertura and JaCoCo coverage parsers.
//
// The existing result parsers each hand-roll their own scanning; coverage adds
// two more XML dialects, so the common part lives here instead of a third and
// fourth copy. Deliberately not a full XML parser -- just enough to walk tags in
// document order while treating comments, CDATA, processing instructions and
// doctypes as opaque, and to read attributes without tripping over a ">" inside
// a quoted value.
export function xmlUnescape(s) {
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
// Python-generated reports use single quotes.
export function attr(attrs, name) {
    const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(String(attrs || ""));
    if (!m)
        return undefined;
    return xmlUnescape(m[1] ?? m[2]);
}
// Attribute parsed as a finite number, or undefined.
export function numAttr(attrs, name) {
    const raw = attr(attrs, name);
    if (raw == null || raw === "")
        return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}
// Index just past `marker`, or end of string.
function skipPast(text, from, marker) {
    const idx = text.indexOf(marker, from);
    return idx < 0 ? text.length : idx + marker.length;
}
// Index of the ">" that ends the tag opened at `from`, ignoring any ">" that
// sits inside a quoted attribute value. -1 when the tag is unterminated.
function tagEnd(text, from) {
    let quote = "";
    for (let i = from; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote)
                quote = "";
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === ">")
            return i;
    }
    return -1;
}
const NAME_END = /[\s/>]/;
// Walk every element tag in document order.
export function* scanTags(xml) {
    const text = String(xml || "");
    let i = 0;
    while (i < text.length) {
        const lt = text.indexOf("<", i);
        if (lt < 0)
            return;
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
        while (j < text.length && !NAME_END.test(text[j]))
            j++;
        const name = text.slice(nameStart, j);
        if (!name) {
            i = lt + 1;
            continue;
        }
        const gt = tagEnd(text, j);
        if (gt < 0)
            return;
        let raw = text.slice(j, gt);
        const selfClosing = raw.trimEnd().endsWith("/");
        if (selfClosing)
            raw = raw.trimEnd().slice(0, -1);
        yield { name, attrs: raw, closing, selfClosing, start: lt, end: gt + 1 };
        i = gt + 1;
    }
}
//# sourceMappingURL=xml.js.map