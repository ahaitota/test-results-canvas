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
const IS_SPACE = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

export function attr(attrs: string | undefined, name: string): string | undefined {
    const text = String(attrs || "");
    const isSpace = IS_SPACE;
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
// https://www.w3.org/TR/xml/#NT-Name, narrowed to the ASCII range reports use.
const XML_NAME = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/;

// Text content with CDATA sections taken literally and the rest unescaped.
export function decodeText(raw: string): string {
    let out = "";
    let i = 0;
    while (i < raw.length) {
        const open = raw.indexOf("<![CDATA[", i);
        if (open < 0) return out + xmlUnescape(raw.slice(i));
        out += xmlUnescape(raw.slice(i, open));
        const close = raw.indexOf("]]>", open + 9);
        if (close < 0) return out + raw.slice(open + 9);
        out += raw.slice(open + 9, close);
        i = close + 3;
    }
    return out;
}

export interface XmlElement {
    name: string;
    attrs: string;
    text: string;
    children: XmlElement[];
}

// Build a tree. The result parsers for NUnit/xUnit/TestNG/CTest read nested
// elements rather than a flat tag stream, and a tree keeps them free of
// format-specific scanning; TRX and JUnit stay streaming for size.
export function parseXml(xml: string): XmlElement {
    const text = String(xml || "");
    const root: XmlElement = { name: "#root", attrs: "", text: "", children: [] };
    const stack: XmlElement[] = [root];
    let pos = 0;
    for (const tag of scanTags(text)) {
        const top = stack[stack.length - 1];
        top.text += decodeText(text.slice(pos, tag.start));
        pos = tag.end;
        if (tag.closing) {
            // Close the nearest open element of that name; an unmatched end tag
            // is ignored rather than unwinding the whole document.
            for (let i = stack.length - 1; i > 0; i--) {
                if (stack[i].name !== tag.name) continue;
                stack.length = i;
                break;
            }
            continue;
        }
        const el: XmlElement = { name: tag.name, attrs: tag.attrs, text: "", children: [] };
        top.children.push(el);
        if (!tag.selfClosing) stack.push(el);
    }
    stack[stack.length - 1].text += decodeText(text.slice(pos));
    return root;
}

export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
    return el?.children.find((c) => c.name === name);
}

// Trimmed text of the first child with that name, or undefined when absent/empty.
export function childText(el: XmlElement | undefined, name: string): string | undefined {
    return child(el, name)?.text.trim() || undefined;
}

// Every descendant with the given name, in document order.
export function* findAll(el: XmlElement, name: string): Generator<XmlElement> {
    for (const c of el.children) {
        if (c.name === name) yield c;
        yield* findAll(c, name);
    }
}

// The document's opening element, or undefined for a document with none. Read
// through the tag scanner, so a name that only appears inside CDATA, a comment,
// an attribute value or text is not markup and cannot pass for the root -- an
// NUnit failure message quoting "<testsuite>" must not make the file JUnit.
export function rootTag(xml: string): XmlTag | undefined {
    for (const tag of scanTags(xml)) {
        if (!tag.closing) return tag;
    }
    return undefined;
}

// True when an element with that name appears as real markup anywhere.
export function hasElement(xml: string, name: string): boolean {
    for (const tag of scanTags(xml)) {
        if (!tag.closing && tag.name === name) return true;
    }
    return false;
}

// True when a tag's attribute text is nothing but well-formed, uniquely named
// name="value" pairs. XML requires every value to be quoted and every name to
// appear once, so a bare or repeated one (name=x, name="a" name="b") means the
// file was not written by a conforming serializer -- and since attr() can only
// skip what it cannot read, and returns the first match of a name, that would
// otherwise surface as a run whose tests quietly lost or swapped their names.
export function attrsWellFormed(attrs: string): boolean {
    const text = String(attrs || "");
    const seen = new Set<string>();
    let i = 0;
    while (i < text.length) {
        while (i < text.length && IS_SPACE(text[i])) i++;
        if (i >= text.length) return true;
        const keyStart = i;
        while (i < text.length && !IS_SPACE(text[i]) && text[i] !== "=") i++;
        const key = text.slice(keyStart, i);
        if (!XML_NAME.test(key)) return false; // "=" with no name, or not a name
        if (seen.has(key)) return false;
        seen.add(key);
        while (i < text.length && IS_SPACE(text[i])) i++;
        if (text[i] !== "=") return false; // a bare token, not an attribute
        i++;
        while (i < text.length && IS_SPACE(text[i])) i++;
        const quote = text[i];
        if (quote !== '"' && quote !== "'") return false;
        const close = text.indexOf(quote, i + 1);
        if (close < 0) return false;
        i = close + 1;
        if (i < text.length && !IS_SPACE(text[i])) return false; // no separator
    }
    return true;
}

// Whitespace, comments, processing instructions and the doctype are the only
// content XML allows outside the document element. Scanned rather than matched
// with a regex, so a long run of text costs one pass and never backtracks.
function isMisc(text: string): boolean {
    let i = 0;
    while (i < text.length) {
        if (IS_SPACE(text[i])) {
            i++;
            continue;
        }
        if (text.startsWith("<!--", i)) {
            const end = text.indexOf("-->", i + 4);
            if (end < 0) return false;
            i = end + 3;
            continue;
        }
        if (text.startsWith("<?", i) || text.startsWith("<!", i)) {
            const end = text.indexOf(">", i);
            if (end < 0) return false;
            i = end + 1;
            continue;
        }
        return false;
    }
    return true;
}

// True when the document is one complete element tree: every element that opened
// also closed, in order, under a valid XML name; every attribute is quoted and
// named once; nothing was left unterminated; there is exactly one document
// element; and nothing but misc content sits outside it. A half-written report
// is structurally incomplete long before it is obviously wrong, and parseXml()
// is deliberately lenient -- so this is what stops a truncated or malformed file
// from replacing a finished run with whatever happened to be flushed.
export function isWellFormed(xml: string): boolean {
    const text = String(xml || "");
    const stack: string[] = [];
    const tags = scanTags(text);
    let roots = 0;
    let pos = 0;
    for (;;) {
        const next = tags.next();
        if (next.done) return next.value && roots === 1 && stack.length === 0 && isMisc(text.slice(pos));
        const tag = next.value;
        // Outside the root, only misc content: text before or after the document
        // element is two documents concatenated, or one with noise around it.
        if (!stack.length && !isMisc(text.slice(pos, tag.start))) return false;
        pos = tag.end;
        if (!XML_NAME.test(tag.name)) return false;
        if (tag.closing) {
            // "</a/>" is not an end tag, and an end tag carries no attributes.
            if (tag.selfClosing || tag.attrs.trim()) return false;
            if (stack.pop() !== tag.name) return false;
            continue;
        }
        if (!attrsWellFormed(tag.attrs)) return false;
        // An XML document has exactly one element at the top level.
        if (!stack.length) roots++;
        if (!tag.selfClosing) stack.push(tag.name);
    }
}

// Walk every element tag in document order. Returns false when the document ran
// out mid-construct (an unterminated tag, comment or CDATA) -- `for...of`
// discards that, so only callers that care about structure read it.
export function* scanTags(xml: string): Generator<XmlTag, boolean> {
    const text = String(xml || "");
    let i = 0;
    while (i < text.length) {
        const lt = text.indexOf("<", i);
        if (lt < 0) return true;
        if (text.startsWith("<!--", lt)) {
            const end = text.indexOf("-->", lt + 4);
            if (end < 0) return false;
            i = end + 3;
            continue;
        }
        if (text.startsWith("<![CDATA[", lt)) {
            const end = text.indexOf("]]>", lt + 9);
            if (end < 0) return false;
            i = end + 3;
            continue;
        }
        if (text.startsWith("<?", lt) || text.startsWith("<!", lt)) {
            const gt = text.indexOf(">", lt);
            if (gt < 0) return false;
            i = gt + 1;
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
        if (gt < 0) return false;
        let raw = text.slice(j, gt);
        const selfClosing = raw.trimEnd().endsWith("/");
        if (selfClosing) raw = raw.trimEnd().slice(0, -1);
        yield { name, attrs: raw, closing, selfClosing, start: lt, end: gt + 1 };
        i = gt + 1;
    }
    return true;
}
