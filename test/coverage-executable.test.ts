// Unit tests for the "could this line execute?" classifier.
//
// The bias under test is asymmetry: dropping a line that does run would hide
// untested code, so every ambiguous case must stay counted. Most of these
// assertions are therefore about what is *kept*.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { commentSyntaxFor, nonExecutableLines } from "../src/coverage/executable.js";

const inertC = (src: string) => [...nonExecutableLines(src, "c")].sort((a, b) => a - b);
const inertHash = (src: string) => [...nonExecutableLines(src, "hash")].sort((a, b) => a - b);

// --- dialects ---------------------------------------------------------------

test("commentSyntaxFor recognises the families, and admits when it does not know", () => {
  for (const p of ["a.ts", "a.tsx", "a.cs", "a.go", "a.java", "a.cpp", "src/deep/a.mjs"]) {
    assert.equal(commentSyntaxFor(p), "c", p);
  }
  for (const p of ["a.py", "a.rb", "a.sh", "a.yml"]) assert.equal(commentSyntaxFor(p), "hash", p);
  assert.equal(commentSyntaxFor("Makefile"), "none", "no extension means no dialect");
  assert.equal(commentSyntaxFor("a.elixir"), "none");
  assert.equal(commentSyntaxFor(""), "none");
});

test("an unknown dialect still discards blank lines, since no language runs whitespace", () => {
  assert.deepEqual([...nonExecutableLines("code\n\n   \ncode", "none")], [2, 3]);
});

// --- the plain cases --------------------------------------------------------

test("blank and comment-only lines are discarded", () => {
  const src = [
    "// a header comment", // 1
    "", //                    2
    "const a = 1;", //        3
    "   ", //                 4
    "  // indented", //       5
    "const b = 2;", //        6
  ].join("\n");
  assert.deepEqual(inertC(src), [1, 2, 4, 5]);
});

test("a block comment is discarded across every line it spans", () => {
  const src = [
    "/*", //          1
    " * prose", //    2
    " */", //         3
    "run();", //      4
  ].join("\n");
  assert.deepEqual(inertC(src), [1, 2, 3]);
});

test("hash comments are discarded, and slashes in those files are not comments", () => {
  // A trailing newline leaves a final empty line, hence 4 as well as 3.
  assert.deepEqual(inertHash("# note\nx = 1\n\n"), [1, 3, 4]);
  assert.deepEqual(inertHash("x = a // b"), [], "// is a real operator in some hash languages");
});

// --- what must be kept ------------------------------------------------------

test("a line with code before or after a comment is kept", () => {
  const src = [
    "run(); // trailing", //     1
    "/* lead */ run();", //      2
    "call(/* inline */ x);", //  3
  ].join("\n");
  assert.deepEqual(inertC(src), [], "none of these lines are pure comment");
});

test("code after a block comment closes on the same line is kept", () => {
  const src = [
    "/* opens", // 1
    "   still", // 2
    "*/ run();", // 3
  ].join("\n");
  assert.deepEqual(inertC(src), [1, 2], "line 3 ends the comment but then runs something");
});

test("comment markers inside string literals do not start a comment", () => {
  const src = [
    'const url = "https://example.com";', // 1
    "const hash = '#not-a-comment';", //     2
    'const s = "/* not a block */";', //     3
    "next();", //                            4
  ].join("\n");
  assert.deepEqual(inertC(src), []);
});

// The dangerous direction: text that merely looks like a comment but is string
// content belonging to a statement that really does run.
test("a comment-looking line inside a template literal is kept", () => {
  const src = [
    "const t = `", //   1
    "// not code but part of a running statement", // 2
    "`;", //            3
  ].join("\n");
  assert.deepEqual(inertC(src), [], "nothing here is provably inert");
});

test("an apostrophe in a comment does not swallow the rest of the file", () => {
  const src = [
    "// it's a contraction", // 1
    "run();", //                2
    "// and another's", //      3
    "runAgain();", //           4
  ].join("\n");
  assert.deepEqual(inertC(src), [1, 3], "lines 2 and 4 must stay counted");
});

test("an unterminated quote does not leak past the end of its line", () => {
  const src = [
    "const broken = 'oops;", // 1
    "run();", //                2
    "", //                      3
  ].join("\n");
  assert.deepEqual(inertC(src), [3], "line 2 is still code");
});

test("escapes inside strings are respected", () => {
  const src = [
    'const q = "a \\" // still string";', // 1
    "run();", //                             2
  ].join("\n");
  assert.deepEqual(inertC(src), []);
});

test("braces are kept, because a lone brace can be a real execution point", () => {
  const src = [
    "function f() {", // 1
    "  return 1;", //    2
    "}", //              3
  ].join("\n");
  assert.deepEqual(inertC(src), [], "removing line 3 could hide a function nothing called");
});

test("empty input is handled without inventing lines", () => {
  assert.deepEqual(inertC(""), [1], "one empty line in, one inert line out");
  assert.deepEqual([...nonExecutableLines("", "none")], [1]);
});

test("CRLF sources classify the same as LF", () => {
  assert.deepEqual(inertC("// c\r\nrun();\r\n\r\n"), [1, 3, 4]);
  assert.deepEqual(inertC("// c\nrun();\n\n"), [1, 3, 4], "the two line endings agree");
});
