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
export declare function scanTags(xml: string): Generator<XmlTag>;
