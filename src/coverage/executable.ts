// Which lines of a source file could actually execute.
//
// Coverage tools disagree about this. coverlet and JaCoCo emit only executable
// lines, so a comment never appears in their reports at all. Node's
// --experimental-test-coverage emits a DA entry for very nearly every line,
// comments and blank lines included, and marks them hit or not according to
// whichever V8 range encloses them. Read literally, that says a third of this
// repository's "uncovered" lines are prose.
//
// So the report alone cannot be trusted to say what is coverable, and the
// source has to be consulted. The rule here is deliberately asymmetric: a line
// is dropped only when the text proves nothing could run on it. Everything
// uncertain stays counted, because over-counting shows a line as untested that
// nobody needed to test, while under-counting hides real untested code -- and
// only one of those two mistakes is dangerous.
//
// Braces are therefore kept. A lone `}` looks inert, but it is a genuine
// execution point in several languages (a method's implicit return, and what
// coverlet reports when a function is never entered), so removing it could
// conceal a function nothing ever called.

export type CommentSyntax = "c" | "hash" | "none";

// Languages whose whole-line comments start with // or are wrapped in /* */.
const C_LIKE = new Set([
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
    "cs", "java", "kt", "kts", "scala", "groovy",
    "go", "rs", "swift", "dart", "php",
    "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm",
]);

// Languages whose whole-line comments start with #.
const HASH_LIKE = new Set(["py", "rb", "sh", "bash", "zsh", "pl", "pm", "r", "yaml", "yml", "toml"]);

export function commentSyntaxFor(path: string): CommentSyntax {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(path || ""));
    if (!m) return "none";
    const ext = m[1]!.toLowerCase();
    if (C_LIKE.has(ext)) return "c";
    if (HASH_LIKE.has(ext)) return "hash";
    // An unfamiliar extension still gets blank lines removed: no language runs
    // whitespace, so that much needs no dialect knowledge.
    return "none";
}

type ScanState = {
    block: boolean;
    quote: "" | "'" | '"' | "`";
};

// Walk one line, tracking string and block-comment state across calls, and
// report whether anything on it could execute. Characters inside a string
// literal count as code: they are part of an expression, and a line in the
// middle of a template literal or a docstring belongs to a statement that runs.
function scanLine(line: string, syntax: CommentSyntax, state: ScanState): boolean {
    let code = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        const next = line[i + 1];

        if (state.block) {
            if (syntax === "c" && ch === "*" && next === "/") {
                state.block = false;
                i++;
            }
            continue;
        }

        if (state.quote) {
            code = true;
            if (ch === "\\") {
                i++;
                continue;
            }
            if (ch === state.quote) state.quote = "";
            continue;
        }

        if (ch === " " || ch === "\t" || ch === "\r") continue;

        if (syntax === "c") {
            // The rest of the line is a comment; state is unchanged.
            if (ch === "/" && next === "/") return code;
            if (ch === "/" && next === "*") {
                state.block = true;
                i++;
                continue;
            }
        }
        if (syntax === "hash" && ch === "#") return code;

        if (ch === "'" || ch === '"' || (syntax === "c" && ch === "`")) {
            state.quote = ch as ScanState["quote"];
            code = true;
            continue;
        }

        code = true;
    }
    return code;
}

// Line numbers (1-based) that provably cannot execute, because nothing but
// whitespace and comments appears on them.
export function nonExecutableLines(text: string, syntax: CommentSyntax): Set<number> {
    const out = new Set<number>();
    const lines = String(text ?? "").split(/\r?\n/);
    const state: ScanState = { block: false, quote: "" };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (syntax === "none") {
            // Without a dialect, only whitespace is safe to call inert.
            if (line.trim() === "") out.add(i + 1);
            continue;
        }
        // An unterminated string cannot span lines outside a template literal,
        // so a stray quote never derails the rest of the file.
        if (state.quote && state.quote !== "`") state.quote = "";
        if (!scanLine(line, syntax, state)) out.add(i + 1);
    }
    return out;
}
