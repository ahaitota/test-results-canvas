// What to tell the user (or the agent) when a test run produced no coverage.
// This is by far the most common state, since almost no runner collects
// coverage unless asked. Rather than show an empty panel, the canvas names the
// exact command for the project in front of it. Detection is by marker file.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoverageSuggestion } from "./model/payload.js";

export type { CoverageSuggestion } from "./model/payload.js";

const VSTEST = {
    ecosystem: ".NET (VSTest)",
    command: 'dotnet test --collect:"XPlat Code Coverage"',
    outputHint: "TestResults/<guid>/coverage.cobertura.xml",
};

// Before .NET 10 -- and on .NET 10 without the global.json opt-in -- `dotnet
// test` bridges Microsoft.Testing.Platform through VSTest, which rejects runner
// options unless they follow `--`.
function testingPlatform(nativeDotnetTest: boolean) {
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

function boolProp(xml: string, name: string): boolean | undefined {
    const m = new RegExp(`<${name}\\s*>\\s*(true|false)\\s*</${name}\\s*>`, "i").exec(xml);
    return m ? m[1].toLowerCase() === "true" : undefined;
}

function readProjectXml(dir: string, depth = 3): string {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return "";
    }
    return entries.map((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return depth > 0 && !SKIP_DIR.test(e.name) ? readProjectXml(p, depth - 1) : "";
        if (!/\.(csproj|fsproj)$/i.test(e.name) && !/^directory\.build\.props$/i.test(e.name)) return "";
        try {
            return readFileSync(p, "utf8");
        } catch {
            return "";
        }
    }).join("\n");
}

// Which runner `dotnet test` will actually use. Package names cannot answer
// this: xunit.v3 ships the VSTest adapter too, and MSTest.Sdk -- which defaults
// to the platform -- can be opted back out. So the settings decide, and only
// TUnit, which has no VSTest mode, is taken from its package alone.
function usesTestingPlatform(xml: string): boolean {
    if (boolProp(xml, "UseVSTest") === true) return false;
    const set = RUNNER_PROPS.map((p) => boolProp(xml, p));
    if (set.some((v) => v === true)) return true;
    if (set.some((v) => v === false)) return false;
    return /(Project\s+Sdk|<Sdk\b[^>]*\bName)\s*=\s*"MSTest\.Sdk/i.test(xml) || /Include\s*=\s*"TUnit/i.test(xml);
}

// .NET 10 only runs the platform natively when global.json asks for it.
function nativeDotnetTest(root: string): boolean {
    try {
        return /"runner"\s*:\s*"Microsoft\.Testing\.Platform"/i.test(readFileSync(join(root, "global.json"), "utf8"));
    } catch {
        return false;
    }
}

function dotnet(root: string | undefined): CoverageSuggestion {
    const platform = testingPlatform(root ? nativeDotnetTest(root) : false);
    return root && usesTestingPlatform(readProjectXml(root))
        ? { ...platform, alternative: VSTEST }
        : { ...VSTEST, alternative: platform };
}

const FALLBACK: CoverageSuggestion = {
    ecosystem: "your test runner",
    command: "re-run the tests with coverage enabled",
    outputHint: "a Cobertura, LCOV or JaCoCo report",
};

function hasFileMatching(dir: string, re: RegExp): boolean {
    try {
        return readdirSync(dir).some((n) => re.test(n));
    } catch {
        return false;
    }
}

function readPackageJson(root: string): string {
    try {
        // Only dependency names matter, so text saves caring about valid JSON.
        return readFileSync(join(root, "package.json"), "utf8");
    } catch {
        return "";
    }
}

// Pick the command for a project. The results file is a tie-breaker: a .trx can
// only have come from the .NET toolchain.
export function suggestCoverageCommand(projectRoot: string | undefined, resultsFile?: string): CoverageSuggestion {
    if (resultsFile && resultsFile.toLowerCase().endsWith(".trx")) return dotnet(projectRoot);
    if (!projectRoot || !existsSync(projectRoot)) return FALLBACK;

    if (hasFileMatching(projectRoot, /\.(sln|csproj|fsproj)$/i)) return dotnet(projectRoot);

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
