// Writes the synthetic benchmark fixtures to bench/fixtures/ (gitignored: large
// and reproducible from the seed).
//
//   node --import tsx bench/gen-fixtures.ts            # every scale
//   node --import tsx bench/gen-fixtures.ts 1000 10000 # just these
//
// The bench spec calls fixturePath() itself, so this is only needed to inspect a
// fixture by hand or to warm them before a timed run.
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateResults, toJUnitXml, SCALES } from "./fixtures.js";

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixturePath(count: number): string {
  return join(FIXTURES_DIR, `bench-${count}.junit.xml`);
}

// Write the fixture for `count` unless it is already on disk. Returns its path.
export function ensureFixture(count: number): string {
  const path = fixturePath(count);
  if (existsSync(path) && statSync(path).size > 0) return path;
  mkdirSync(FIXTURES_DIR, { recursive: true });
  writeFileSync(path, toJUnitXml(generateResults(count)), "utf8");
  return path;
}

// `import.meta.url` matches argv[1] only when this file is the entry point.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1]);
if (invokedDirectly) {
  const args = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const counts = args.length ? args : [...SCALES];
  for (const count of counts) {
    const path = ensureFixture(count);
    console.log(`${count.toLocaleString("en-US").padStart(7)} tests -> ${path} (${(statSync(path).size / 1e6).toFixed(1)} MB)`);
  }
}
