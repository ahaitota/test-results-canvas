export type CommentSyntax = "c" | "hash" | "none";
export declare function commentSyntaxFor(path: string): CommentSyntax;
export declare function nonExecutableLines(text: string, syntax: CommentSyntax): Set<number>;
