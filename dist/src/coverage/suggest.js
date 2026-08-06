// What to tell a user (or the agent) when a test run produced no coverage.
//
// This is the most common state by far: almost no runner collects coverage
// unless asked. Rather than showing an empty panel, the canvas names the exact
// command for the project in front of it -- which is the difference between the
// feature being useful and being ignored.
//
// Detection is by marker file, so it works without running anything.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const DOTNET = {
    ecosystem: ".NET",
    command: 'dotnet test --collect:"XPlat Code Coverage"',
    outputHint: "TestResults/<guid>/coverage.cobertura.xml",
};
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
        // Only the dependency names matter, and reading it as text avoids
        // caring whether the file is valid JSON.
        return readFileSync(join(root, "package.json"), "utf8");
    }
    catch {
        return "";
    }
}
// Pick the suggestion for a project, using the results file as a tie-breaker:
// a .trx can only have come from the .NET toolchain.
export function suggestCoverageCommand(projectRoot, resultsFile) {
    if (resultsFile && resultsFile.toLowerCase().endsWith(".trx"))
        return DOTNET;
    if (!projectRoot || !existsSync(projectRoot))
        return FALLBACK;
    if (hasFileMatching(projectRoot, /\.(sln|csproj|fsproj)$/i))
        return DOTNET;
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
