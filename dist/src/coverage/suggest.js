// What to tell the user (or the agent) when a test run produced no coverage.
// This is by far the most common state, since almost no runner collects
// coverage unless asked. Rather than show an empty panel, the canvas names the
// exact command for the project in front of it. Detection is by marker file.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
const VSTEST = {
    ecosystem: ".NET (VSTest)",
    command: 'dotnet test --collect:"XPlat Code Coverage"',
    outputHint: "TestResults/<guid>/coverage.cobertura.xml",
};
// Before .NET 10 -- and on .NET 10 without the global.json opt-in -- `dotnet
// test` bridges Microsoft.Testing.Platform through VSTest, which rejects runner
// options unless they follow `--`.
function testingPlatform(nativeDotnetTest) {
    return {
        ecosystem: ".NET (Microsoft.Testing.Platform)",
        command: `dotnet test ${nativeDotnetTest ? "" : "-- "}--coverage --coverage-output-format cobertura`,
        outputHint: "TestResults/*.cobertura.xml",
    };
}
// Properties that turn the platform on, in the framework-specific spellings.
const RUNNER_PROPS = ["EnableMSTestRunner", "UseMicrosoftTestingPlatformRunner", "EnableNUnitRunner", "UseMicrosoftTestingPlatform"];
// A repository root often holds only the .sln, with the test project nested
// under tests/ -- so the search descends, bounded, rather than reading the root.
const SKIP_DIR = /^(bin|obj|node_modules|TestResults|packages)$|^\./i;
// The last match wins: MSBuild imports Directory.Build.props before the
// project, so a value the project sets itself is the decisive one.
function boolProp(xml, name) {
    const m = [...xml.matchAll(new RegExp(`<${name}\\s*>\\s*(true|false)\\s*</${name}\\s*>`, "gi"))].pop();
    return m ? m[1].toLowerCase() === "true" : undefined;
}
function entriesOf(dir) {
    try {
        return readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
}
function readText(path) {
    try {
        return readFileSync(path, "utf8");
    }
    catch {
        return "";
    }
}
const isProps = (n) => /^directory\.build\.props$/i.test(n);
const isProject = (n) => /\.(csproj|fsproj)$/i.test(n);
// The project that owns the run, plus the props it inherits, in MSBuild's
// evaluation order -- outermost props first, the owning project last. Reading
// every project instead would let one project's opt-out decide another's run.
function ownerXml(root, resultsFile) {
    const props = [];
    let project = "";
    for (let d = dirname(resolvePath(resultsFile)), i = 0; i < 12; d = dirname(d), i++) {
        for (const e of entriesOf(d)) {
            if (e.isDirectory())
                continue;
            if (isProps(e.name))
                props.unshift(readText(join(d, e.name)));
            else if (!project && isProject(e.name))
                project = readText(join(d, e.name));
        }
        if (d === root || dirname(d) === d)
            break;
    }
    return project ? [...props, project].join("\n") : "";
}
// The verdict of every project below the root, each read with the props it
// inherits. Results written to a central folder name no project, so a solution
// whose projects disagree has to stay undecided rather than pick one of them.
function scanRunners(dir, inherited, depth, found) {
    const entries = entriesOf(dir);
    const here = [inherited, ...entries.filter((e) => !e.isDirectory() && isProps(e.name)).map((e) => readText(join(dir, e.name)))].join("\n");
    for (const e of entries) {
        if (e.isDirectory()) {
            if (depth > 0 && !SKIP_DIR.test(e.name))
                scanRunners(join(dir, e.name), here, depth - 1, found);
        }
        else if (isProject(e.name)) {
            found.add(usesTestingPlatform([here, readText(join(dir, e.name))].join("\n")));
        }
    }
}
// Which runner `dotnet test` will actually use. Package names cannot answer
// this: xunit.v3 ships the VSTest adapter too, and MSTest.Sdk -- which defaults
// to the platform -- can be opted back out. So the settings decide, and only
// TUnit, which has no VSTest mode, is taken from its package alone.
function usesTestingPlatform(xml) {
    if (boolProp(xml, "UseVSTest") === true)
        return false;
    const set = RUNNER_PROPS.map((p) => boolProp(xml, p));
    if (set.some((v) => v === true))
        return true;
    if (set.some((v) => v === false))
        return false;
    return /(Project\s+Sdk|<Sdk\b[^>]*\bName)\s*=\s*["']MSTest\.Sdk/i.test(xml) || /Include\s*=\s*["']TUnit/i.test(xml);
}
// .NET 10 only runs the platform natively when global.json asks for it.
function nativeDotnetTest(root) {
    return /"runner"\s*:\s*"Microsoft\.Testing\.Platform"/i.test(readText(join(root, "global.json")));
}
function dotnet(root, resultsFile) {
    const platform = testingPlatform(root ? nativeDotnetTest(root) : false);
    const owner = root && resultsFile ? ownerXml(root, resultsFile) : "";
    let mtp;
    if (owner) {
        mtp = usesTestingPlatform(owner);
    }
    else if (root) {
        const found = new Set();
        scanRunners(root, "", 3, found);
        mtp = found.size === 1 ? [...found][0] : undefined;
    }
    if (mtp === true)
        return { ...platform, alternative: VSTEST };
    // Undecided: offer both without claiming either is the one in use.
    return { ...VSTEST, ecosystem: mtp === false ? VSTEST.ecosystem : ".NET (runner not detected)", alternative: platform };
}
const FALLBACK = {
    ecosystem: "your test runner",
    command: "re-run the tests with coverage enabled",
    outputHint: "a Cobertura, LCOV or JaCoCo report",
};
function hasFileMatching(dir, re) {
    try {
        return readdirSync(dir).some((n) => re.test(n));
    }
    catch {
        return false;
    }
}
function readPackageJson(root) {
    try {
        // Only dependency names matter, so text saves caring about valid JSON.
        return readFileSync(join(root, "package.json"), "utf8");
    }
    catch {
        return "";
    }
}
// Pick the command for a project. The results file is a tie-breaker: a .trx can
// only have come from the .NET toolchain.
export function suggestCoverageCommand(projectRoot, resultsFile) {
    if (resultsFile && resultsFile.toLowerCase().endsWith(".trx"))
        return dotnet(projectRoot, resultsFile);
    if (!projectRoot || !existsSync(projectRoot))
        return FALLBACK;
    if (hasFileMatching(projectRoot, /\.(sln|csproj|fsproj)$/i))
        return dotnet(projectRoot, resultsFile);
    if (existsSync(join(projectRoot, "pom.xml"))) {
        return {
            ecosystem: "Maven",
            command: "mvn test jacoco:report",
            outputHint: "target/site/jacoco/jacoco.xml",
        };
    }
    if (existsSync(join(projectRoot, "build.gradle")) || existsSync(join(projectRoot, "build.gradle.kts"))) {
        return {
            ecosystem: "Gradle",
            command: "./gradlew test jacocoTestReport",
            outputHint: "build/reports/jacoco/test/jacocoTestReport.xml",
        };
    }
    if (existsSync(join(projectRoot, "package.json"))) {
        const pkg = readPackageJson(projectRoot);
        if (/"vitest"\s*:/.test(pkg)) {
            return { ecosystem: "Vitest", command: "npx vitest run --coverage", outputHint: "coverage/lcov.info" };
        }
        if (/"jest"\s*:/.test(pkg)) {
            return { ecosystem: "Jest", command: "npx jest --coverage --coverageReporters=lcov", outputHint: "coverage/lcov.info" };
        }
        return {
            ecosystem: "Node.js",
            command: "npx c8 --reporter=lcov npm test",
            outputHint: "coverage/lcov.info",
        };
    }
    if (existsSync(join(projectRoot, "pyproject.toml")) || existsSync(join(projectRoot, "setup.py")) || existsSync(join(projectRoot, "pytest.ini"))) {
        return {
            ecosystem: "pytest",
            command: "pytest --cov --cov-report=xml",
            outputHint: "coverage.xml",
        };
    }
    if (existsSync(join(projectRoot, "go.mod"))) {
        return {
            ecosystem: "Go",
            command: "go test ./... -coverprofile=coverage.out && gocover-cobertura < coverage.out > coverage.xml",
            outputHint: "coverage.xml",
        };
    }
    if (existsSync(join(projectRoot, "Cargo.toml"))) {
        return {
            ecosystem: "Rust",
            command: "cargo llvm-cov --lcov --output-path lcov.info",
            outputHint: "lcov.info",
        };
    }
    return FALLBACK;
}
//# sourceMappingURL=suggest.js.map