// node:test's junit reporter omits the <testsuite> level that dorny/test-reporter
// requires, so CI reports come up empty without this. Idempotent. Takes <junit.xml>.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const file = process.argv[2];
if (!file || !existsSync(file)) process.exit(0);         // nothing to do

let xml = readFileSync(file, "utf8");
if (xml.includes("<testsuite ")) process.exit(0);        // already wrapped

const count = (re: RegExp): number => (xml.match(re) || []).length;      // count tag-opens only
const attrs =
  `name="unit" tests="${count(/<testcase\b/g)}" failures="${count(/<failure\b/g)}"` +
  ` errors="${count(/<error\b/g)}" skipped="${count(/<skipped\b/g)}"`;

xml = xml
  .replace(/(<testsuites\b[^>]*>)/, `$1\n<testsuite ${attrs}>`)
  .replace(/(<\/testsuites>)/, `</testsuite>\n$1`);

writeFileSync(file, xml);
console.log(`wrap-junit: wrapped ${count(/<testcase\b/g)} testcase(s) in ${file}`);
