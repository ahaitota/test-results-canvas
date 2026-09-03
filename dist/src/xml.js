// Minimal XML helpers shared by the result and coverage parsers. Not a full XML
// parser -- just enough to walk tags in document order, treating comments, CDATA
// and doctypes as opaque, and to read attributes without tripping over a ">"
// inside a quoted value.
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
export function attr(attrs, name) {
    const text = String(attrs || "");
    const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";
    let i = 0;
    while (i < text.length) {
        while (i < text.length && isSpace(text[i]))
            i++;
        const keyStart = i;
        while (i < text.length && !isSpace(text[i]) && text[i] !== "=")
            i++;
        const key = text.slice(keyStart, i);
        while (i < text.length && isSpace(text[i]))
            i++;
        if (text[i] !== "=")
            continue; // a bare token, not an attribute
        i++;
        while (i < text.length && isSpace(text[i]))
            i++;
        const quote = text[i];
        if (quote !== '"' && quote !== "'")
            continue; // unquoted value: not well-formed
        const valueStart = ++i;
        while (i < text.length && text[i] !== quote)
            i++;
        const value = text.slice(valueStart, i);
        i++; // step past the closing quote
        if (key === name)
            return xmlUnescape(value);
    }
    return undefined;
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
// Text content with CDATA sections taken literally and the rest unescaped.
export function decodeText(raw) {
    let out = "";
    let i = 0;
    while (i < raw.length) {
        const open = raw.indexOf("<![CDATA[", i);
        if (open < 0)
            return out + xmlUnescape(raw.slice(i));
        out += xmlUnescape(raw.slice(i, open));
        const close = raw.indexOf("]]>", open + 9);
        if (close < 0)
            return out + raw.slice(open + 9);
        out += raw.slice(open + 9, close);
        i = close + 3;
    }
    return out;
}
// Build a tree. The result parsers for NUnit/xUnit/TestNG/CTest read nested
// elements rather than a flat tag stream, and a tree keeps them free of
// format-specific scanning; TRX and JUnit stay streaming for size.
export function parseXml(xml) {
    const text = String(xml || "");
    const root = { name: "#root", attrs: "", text: "", children: [] };
    const stack = [root];
    let pos = 0;
    for (const tag of scanTags(text)) {
        const top = stack[stack.length - 1];
        top.text += decodeText(text.slice(pos, tag.start));
        pos = tag.end;
        if (tag.closing) {
            // Close the nearest open element of that name; an unmatched end tag
            // is ignored rather than unwinding the whole document.
            for (let i = stack.length - 1; i > 0; i--) {
                if (stack[i].name !== tag.name)
                    continue;
                stack.length = i;
                break;
            }
            continue;
        }
        const el = { name: tag.name, attrs: tag.attrs, text: "", children: [] };
        top.children.push(el);
        if (!tag.selfClosing)
            stack.push(el);
    }
    stack[stack.length - 1].text += decodeText(text.slice(pos));
    return root;
}
export function child(el, name) {
    return el?.children.find((c) => c.name === name);
}
// Trimmed text of the first child with that name, or undefined when absent/empty.
export function childText(el, name) {
    return child(el, name)?.text.trim() || undefined;
}
// Every descendant with the given name, in document order.
export function* findAll(el, name) {
    for (const c of el.children) {
        if (c.name === name)
            yield c;
        yield* findAll(c, name);
    }
}
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