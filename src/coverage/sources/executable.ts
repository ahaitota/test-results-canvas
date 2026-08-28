// Works out which lines of a source file could actually run.
//
// Coverage tools disagree about this. coverlet and JaCoCo list only executable
// lines, while Node's --experimental-test-coverage lists nearly every line,
// comments included -- which made about a third of this repo's "uncovered"
// lines prose.
//
// The rule is deliberately one-sided: a line is only dropped when the text
// proves nothing on it could run. Counting too many shows something as untested
// that never needed a test; counting too few hides real untested code, and only
// that second mistake is dangerous. Braces are kept for the same reason.

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

// Which comment style a file uses, guessed from its extension.
export function commentSyntaxFor(path: string): CommentSyntax {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(path || ""));
    if (!m) return "none";
    const ext = m[1]!.toLowerCase();
    if (C_LIKE.has(ext)) return "c";
    if (HASH_LIKE.has(ext)) return "hash";
    // An unknown extension still gets blank lines removed: no language runs
    // whitespace, so that needs no knowledge of the language.
    return "none";
}

type ScanState = {
    block: boolean;
    quote: "" | "'" | '"' | "`";
};

// Walk one line and say whether anything on it could run, carrying string and
// block-comment state across calls. Text inside a string counts as code: a line
// in the middle of a template literal belongs to a statement that runs.
function scanLine(line: string, syntax: CommentSyntax, state: ScanState): boolean {
    let code = false;
    // A regex literal cannot span lines, so this resets with every call. An odd
    // count means an unclosed `/` is open, and anything after it may be regex
    // body rather than source.
    let slashes = 0;
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
            // The rest of the line is a comment; state is unchanged. `//` and
            // `/*` are safe to read first: neither can open a regex literal.
            if (ch === "/" && next === "/") return code;
            // Inside a regex a `/*` is body, not a comment (`/[/*]/`), and
            // believing it would silence the rest of the file. Ambiguity keeps
            // the line instead, the one-sided rule this module is built on.
            if (ch === "/" && next === "*" && slashes % 2 === 0) {
                state.block = true;
                i++;
                continue;
            }
            if (ch === "/") slashes++;
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

// The 1-based line numbers that provably cannot run, because they hold nothing
// but whitespace and comments.
export function nonExecutableLines(text: string, syntax: CommentSyntax): Set<number> {
    const out = new Set<number>();
    const lines = String(text ?? "").split(/\r?\n/);
    const state: ScanState = { block: false, quote: "" };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (syntax === "none") {
            // With no known comment style, only whitespace is safe to drop.
            if (line.trim() === "") out.add(i + 1);
            continue;
        }
        // Outside template literals a string can't span lines, so a stray quote
        // never derails the rest of the file.
        if (state.quote && state.quote !== "`") state.quote = "";
        if (!scanLine(line, syntax, state)) out.add(i + 1);
    }
    return out;
}
