// The LCOV merge that combines what the unit run, the browser and the server
// each observed. Every failure mode here is silent in the output -- a split
// file, a doubled hit count, a dropped record -- so each one is pinned.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatLcov, mergeLcov, normalizePath, parseLcov } from "../scripts/lcov.js";

const lcov = (...records: string[]): string => records.join("\n") + "\n";
const record = (path: string, ...da: string[]): string =>
    [`SF:${path}`, ...da.map((d) => `DA:${d}`), "end_of_record"].join("\n");

describe("normalizePath", () => {
    it("spells a path the same however the tool that emitted it did", () => {
        // The three runners each name the same file differently: tsc's map hops
        // out of dist, esbuild's is relative to the bundle, Node's is absolute.
        const spellings = [
            "../../src/coverage/load.ts",
            "./src/coverage/load.ts",
            "C:\\repo\\src\\coverage\\load.ts",
            "/home/runner/work/repo/src/coverage/load.ts",
        ];
        for (const raw of spellings) assert.equal(normalizePath(raw), "src/coverage/load.ts");
    });

    it("brings a file outside src/ back to the repo root", () => {
        assert.equal(normalizePath("../extension.ts"), "extension.ts");
    });
});

describe("parseLcov", () => {
    it("reads a file's lines and hit counts", () => {
        const files = parseLcov(lcov(record("src/a.ts", "1,3", "2,0")));
        assert.equal(files.length, 1);
        assert.equal(files[0]!.path, "src/a.ts");
        assert.deepEqual([...files[0]!.lines], [[1, 3], [2, 0]]);
    });

    it("keeps a record the report never closed", () => {
        // A run killed mid-write still knows things worth reporting.
        const files = parseLcov("SF:src/a.ts\nDA:1,1\n");
        assert.equal(files.length, 1);
        assert.deepEqual([...files[0]!.lines], [[1, 1]]);
    });

    it("ignores a record that carries no lines", () => {
        const files = parseLcov(lcov(record("src/empty.ts")));
        assert.deepEqual(files, []);
    });
});

describe("mergeLcov", () => {
    it("keeps one entry per file when two runners both measured it", () => {
        // src/coverage/derive.ts is imported by a unit test *and* bundled into
        // the page, so it arrives from both. Two rows for one file would halve
        // its apparent coverage.
        const unit = parseLcov(lcov(record("src/derive.ts", "1,1", "2,0")));
        const browser = parseLcov(lcov(record("src/derive.ts", "1,0", "2,4")));
        const merged = mergeLcov([unit, browser]);
        assert.equal(merged.length, 1);
        assert.deepEqual([...merged[0]!.lines], [[1, 1], [2, 4]]);
    });

    it("counts a line as covered when either runner reached it", () => {
        // The whole point of merging: a line the unit tests never touch is
        // still tested if the e2e run executes it.
        const unit = parseLcov(lcov(record("src/server.ts", "10,0")));
        const server = parseLcov(lcov(record("src/server.ts", "10,7")));
        assert.equal(mergeLcov([unit, server])[0]!.lines.get(10), 7);
    });

    it("treats paths that differ only in case as one file", () => {
        // Windows and macOS filesystems are case-insensitive and the tools
        // disagree; matching raw strings would double every client file.
        const a = parseLcov(lcov(record("src/CoverageView.tsx", "1,1")));
        const b = parseLcov(lcov(record("src/coverageview.tsx", "2,1")));
        assert.equal(mergeLcov([a, b]).length, 1);
    });

    it("carries a file only one runner saw", () => {
        const unit = parseLcov(lcov(record("src/a.ts", "1,1")));
        const browser = parseLcov(lcov(record("src/client/App.tsx", "5,2")));
        assert.deepEqual(mergeLcov([unit, browser]).map((f) => f.path), ["src/a.ts", "src/client/App.tsx"]);
    });

    it("does not double a line when one report names a file twice", () => {
        const twice = parseLcov(lcov(record("src/a.ts", "1,1"), record("src/a.ts", "1,1")));
        assert.equal(mergeLcov([twice])[0]!.lines.get(1), 2);
    });
});

describe("formatLcov", () => {
    it("writes totals a reader can check against the lines above them", () => {
        const out = formatLcov(parseLcov(lcov(record("src/a.ts", "1,1", "2,0", "3,5"))));
        assert.match(out, /^SF:src\/a\.ts$/m);
        assert.match(out, /^LF:3$/m);
        assert.match(out, /^LH:2$/m);
        assert.match(out, /^end_of_record$/m);
    });

    it("round-trips, so merging twice changes nothing", () => {
        const once = mergeLcov([parseLcov(lcov(record("src/a.ts", "2,0", "1,3")))]);
        assert.deepEqual(parseLcov(formatLcov(once)), once);
    });
});
