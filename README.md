# Test Results canvas (Copilot extension)

A GitHub Copilot **canvas extension** that shows your test runs as a live UI panel
inside the Copilot app. It renders **.NET TRX** and **JUnit XML** reports with
pass/fail/skip status, per-test duration, failure messages, filtering/search, and
a summary — and it updates live over SSE every time you re-run the tests.

Once installed, you don't have to do anything special. In **any** project:

1. You write code and ask Copilot to run the tests (`dotnet test`, `mvn test`,
   `pytest --junitxml=...`, `npm test`, etc.).
2. A tool hook notices the run, finds the fresh `.trx`/`.xml` report in your
   working directory, and tells the agent to open this canvas with that file.
3. The **Test Results** panel appears automatically and then live-refreshes on
   every subsequent run — no reopening.

Supported report formats: `.trx` (VSTest/`dotnet test --logger trx`) and JUnit
`.xml` (Maven Surefire, Gradle, pytest, jest-junit, etc.).

## Install (once, per user — works in every project)
### Step 1:

Clone the repo straight into your user extensions directory so the app discovers it:

```bash
# macOS/Linux
git clone https://github.com/ahaitota/test-results-canvas.git ~/.copilot/extensions/test-results-canvas
```
```powershell
# Windows (PowerShell)
git clone https://github.com/ahaitota/test-results-canvas.git "$env:USERPROFILE\.copilot\extensions\test-results-canvas"
```

### Step 2:

Restart the app (or run `/clear`) so the extension loads.

### Step 3:

Open any project and ask the agent to run your test suite — the **Test Results**
panel opens on its own as soon as the report is written, and refreshes on each
re-run.

## Project structure

The extension is written in **TypeScript** and compiled to `dist/` with `tsc`.
The compiled `dist/` output is committed, so cloning the repo is enough to run the
extension — no build step required for end users.

```
extension.ts             entry point source (compiled to dist/extension.js, which
                         package.json "main" points at — the app loads that)
src/
  view.ts                panel UI (CSS + client rendering/filtering/animation)
  server.ts              SDK-free HTTP/SSE server, file loading + watching
  labels.ts              file-picker label disambiguation
  types.ts               shared TestResult / TestStatus types
  parsers/
    trx.ts               .NET TRX parser
    junit.ts             JUnit XML parser
test/
  trx.test.ts            unit tests for the TRX parser
  junit.test.ts          unit tests for the JUnit parser
  labels.test.ts         unit tests for the label generator
e2e/                     Playwright browser tests (load the compiled dist server)
dist/                    compiled JS + .d.ts (committed; regenerate with `npm run build`)
tsconfig.json            type-check config (noEmit)
tsconfig.build.json      build config (emits dist/)
.github/workflows/ci.yml CI: typecheck + build + `node --test` (Node 20 & 22) + e2e
```

## Development

```bash
npm install          # install the TypeScript toolchain + Playwright
npm run build        # compile TypeScript to dist/
npm run typecheck    # type-check without emitting
npm test             # run unit tests (via tsx)
npm run test:e2e     # build + run Playwright e2e tests
```

Intra-project imports use `.js` specifiers (required by NodeNext ESM); `tsc`, `tsx`,
and Playwright resolve them to the `.ts` sources. After changing any source, run
`npm run build` and commit the updated `dist/` so clones keep working out of the box.

