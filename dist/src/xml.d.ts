export declare function xmlUnescape(s: unknown): string;
export declare function attr(attrs: string | undefined, name: string): string | undefined;
export declare function numAttr(attrs: string | undefined, name: string): number | undefined;
export interface XmlTag {
    name: string;
    attrs: string;
    closing: boolean;
    selfClosing: boolean;
    start: number;
    end: number;
}
export declare function decodeText(raw: string): string;
export interface XmlElement {
    name: string;
    attrs: string;
    text: string;
    children: XmlElement[];
}
export declare function parseXml(xml: string): XmlElement;
export declare function child(el: XmlElement | undefined, name: string): XmlElement | undefined;
export declare function childText(el: XmlElement | undefined, name: string): string | undefined;
export declare function findAll(el: XmlElement, name: string): Generator<XmlElement>;
export declare function scanTags(xml: string): Generator<XmlTag>;
