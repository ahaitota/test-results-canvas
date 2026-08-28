// Turn the raw V8 coverage the e2e run collected into LCOV, and merge it with
// the LCOV the Node unit tests produced.
//
// Merged rather than shown separately because the canvas loads one report, and
// "did the code that just changed get tested?" is about the change set, not
// about which runner observed it.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { CoverageReport } from "monocart-coverage-reports";
import { CLIENT_BUILD_DIR, RAW_DIR } from "../e2e/coverage-collect.js";
import { formatLcov, mergeLcov, parseLcov } from "./lcov.js";
import type { LcovFile } from "./lcov.js";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const OUT_DIR = join(ROOT, "test-results");
const NODE_LCOV = join(OUT_DIR, "lcov.info");
const BROWSER_DIR = join(OUT_DIR, "browser-coverage");
const SERVER_DIR = join(OUT_DIR, "server-coverage");
const V8_NODE_DIR = join(OUT_DIR, "v8-node");
const MERGED = join(OUT_DIR, "lcov-merged.info");

// Only this repository's own sources. A bundle drags in Preact, and reporting
// node_modules would swamp the file list with code nobody here can test.
function isOwnSource(path: string): boolean {
    const p = path.replace(/\\/g, "/");
    if (p.includes("node_modules/")) return false;
    return p.includes("src/");
}

// The server half runs the compiled output in dist/. Those are build artefacts,
// so they are mapped back through tsc's source maps -- otherwise the panel would
// list dist/src/server.js beside src/server.ts as two different files.
function isServerBuild(url: string): boolean {
    const p = url.replace(/\\/g, "/");
    if (p.includes("node_modules/")) return false;
    return /\/dist\/(src\/|extension\.js)/.test(p);
}

// Rewrite the paths monocart emits (relative to the bundle's source map) into
// repo-relative paths spelled the way git and the Node LCOV spell them: see
// normalizePath in ./lcov.ts, which parseLcov applies as it reads.

interface RawV8Entry {
    url: string;
    functions?: unknown[];
}

interface ServerEntry {
    url: string;
    source: string;
    functions?: unknown[];
    sourceMap?: unknown;
}

// tsc's maps name their sources but do not carry them: sourcesContent only
// appears with inlineSources, which would embed all of src/ into committed
// artefacts. It is filled in here instead, so dist/ stays lean.
function mapWithSources(jsPath: string): unknown {
    const mapPath = `${jsPath}.map`;
    if (!existsSync(mapPath)) return undefined;
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as { sources?: string[]; sourcesContent?: (string | null)[] };
    if (!Array.isArray(map.sources) || map.sourcesContent) return map;
    const mapDir = dirname(mapPath);
    map.sourcesContent = map.sources.map((s) => {
        const abs = resolve(mapDir, s);
        return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    });
    return map;
}

// NODE_V8_COVERAGE dumps carry no source text, so each entry is paired with the
// file it came from and that file's map before monocart sees it.
function toServerEntries(result: readonly RawV8Entry[]): ServerEntry[] {
    const out: ServerEntry[] = [];
    for (const entry of result) {
        if (!entry.url.startsWith("file://") || !isServerBuild(entry.url)) continue;
        const jsPath = fileURLToPath(entry.url);
        if (!existsSync(jsPath)) continue;
        out.push({
            url: entry.url,
            functions: entry.functions,
            source: readFileSync(jsPath, "utf8"),
            sourceMap: mapWithSources(jsPath),
        });
    }
    return out;
}


async function browserLcov(): Promise<LcovFile[]> {
    if (!existsSync(RAW_DIR)) {
        console.warn("no browser coverage found -- run `npm run test:e2e:coverage` first");
        return [];
    }
    const files = readdirSync(RAW_DIR).filter((f) => f.endsWith(".json"));
    if (!files.length) return [];

    // The bundle the browser actually ran, kept aside by the runner: reading dist/
    // would measure a different build.
    const bundlePath = join(CLIENT_BUILD_DIR, "app.js");
    if (!existsSync(bundlePath)) {
        console.warn("no measured client build found -- run `npm run test:e2e:coverage` first");
        return [];
    }
    const source = readFileSync(bundlePath, "utf8");
    const sourceMap = mapWithSources(bundlePath);

    const report = new CoverageReport({
        outputDir: BROWSER_DIR,
        reports: [["lcovonly", { file: "lcov.info" }]],
        sourceFilter: isOwnSource,
        logging: "error",
        cleanCache: true,
    });
    await report.cleanCache();
    for (const name of files) {
        const entries = JSON.parse(readFileSync(join(RAW_DIR, name), "utf8")) as RawV8Entry[];
        await report.add(entries.map((e) => ({ ...e, source, sourceMap })));
    }
    await report.generate();

    const produced = join(BROWSER_DIR, "lcov.info");
    if (!existsSync(produced)) return [];
    return parseLcov(readFileSync(produced, "utf8"));
}

async function serverLcov(): Promise<LcovFile[]> {
    if (!existsSync(V8_NODE_DIR)) return [];
    const files = readdirSync(V8_NODE_DIR).filter((f) => f.endsWith(".json"));
    if (!files.length) return [];

    const report = new CoverageReport({
        outputDir: SERVER_DIR,
        reports: [["lcovonly", { file: "lcov.info" }]],
        logging: "error",
        cleanCache: true,
    });
    await report.cleanCache();
    for (const name of files) {
        const raw = JSON.parse(readFileSync(join(V8_NODE_DIR, name), "utf8")) as { result?: RawV8Entry[] };
        const list = toServerEntries(raw.result ?? []);
        if (list.length) await report.add(list);
    }
    await report.generate();

    const produced = join(SERVER_DIR, "lcov.info");
    if (!existsSync(produced)) return [];
    return parseLcov(readFileSync(produced, "utf8"));
}

async function main(): Promise<void> {
    mkdirSync(OUT_DIR, { recursive: true });
    const browser = await browserLcov();
    const server = await serverLcov();
    const node = existsSync(NODE_LCOV) ? parseLcov(readFileSync(NODE_LCOV, "utf8")) : [];
    if (!node.length) console.warn("no Node coverage found -- run `npm run test:coverage` first");

    const merged = mergeLcov([node, browser, server]);
    writeFileSync(MERGED, formatLcov(merged), "utf8");

    const isNew = (list: readonly LcovFile[]): number =>
        list.filter((b) => !node.some((n) => n.path.toLowerCase() === b.path.toLowerCase())).length;
    console.log(`unit (node)   : ${node.length} files`);
    console.log(`e2e (browser) : ${browser.length} files (${isNew(browser)} the unit run never saw)`);
    console.log(`e2e (server)  : ${server.length} files (${isNew(server)} the unit run never saw)`);
    console.log(`merged        : ${merged.length} files -> ${relative(ROOT, MERGED).replace(/\\/g, "/")}`);
}

main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
});
