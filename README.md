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

It also shows **code coverage** when the run produced a report (Cobertura, LCOV
or JaCoCo), in a **Coverage** tab beside **Tests**.


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
extension.mjs            discovery entry point — the Copilot app scans for this
                         exact filename (it ignores package.json "main"). One
                         line: it imports dist/extension.js. Never edit.
extension.ts             the real entry point source (compiled to dist/extension.js)
src/
  view.ts                HTML shell + CSS served to the panel (no result rendering)
  server.ts              SDK-free HTTP/SSE server, file loading + watching
  ask.ts                 server-side composition of the "ask agent" prompts
  validate.ts            narrows untrusted agent input at the action/open boundary
  labels.ts              file-picker label disambiguation
  rowkey.ts              stable row identity across live payloads
  types.ts               shared TestResult / TestStatus types
  client/                Preact UI bundled to dist/client/app.js by esbuild
    main.tsx             client entry point
    App.tsx              root component, wires up state and the results stream
    Toolbar.tsx          filter/search controls
    Summary.tsx          pass/fail/skip totals
    ResultsList.tsx      the list of results (renders only the visible window)
    TestRow.tsx          one result row, including failure detail
    virtual.ts           windowing: flattens the list and tracks row heights
    useResultsStream.ts  SSE subscription that drives live refresh
  parsers/
    trx.ts               .NET TRX parser
    junit.ts             JUnit XML parser
  coverage/
    payload.ts           the SSE wire contract, shared with the client (host-free)
    types.ts             CoverageReport / CoverageFile model + tallying
    xml.ts               minimal shared XML scanner
    cobertura.ts         Cobertura parser
    lcov.ts              LCOV parser
    jacoco.ts            JaCoCo parser
    detect.ts            content sniffing — format is never inferred from a name
    discover.ts          find the report paired with a results file (nearest first)
    sources.ts           report paths -> real files; project-root detection
    classify.ts          production vs test vs generated code
    gitdiff.ts           changed lines per file (git exec is injectable)
    patch.ts             changed lines x hit map = patch coverage
    rank.ts              "worth covering" ranking
    suggest.ts           the coverage command for the detected ecosystem
    source.ts            allow-listed source reads behind /source
    load.ts              loads + derives one report end to end
  client/                Preact app, bundled by esbuild to dist/client/app.js
    App.tsx              cross-cutting state; Tests / Coverage branch
    ViewTabs.tsx         the Tests | Coverage switcher
    CoverageView.tsx     the merged file list: one row per file
    SourceView.tsx       gutter-annotated source for one file
    CoverageEmpty.tsx    the no-coverage state and its ask-agent button
    coverageDerive.ts    merges report + patch + hotspots into one row per file
    (Summary, Toolbar, ResultsList, TestRow, derive, ...)  the results view
test/
  trx.test.ts            unit tests for the TRX parser
  junit.test.ts          unit tests for the JUnit parser
  labels.test.ts         unit tests for the label generator
  rowkey.test.ts         unit tests for row identity
  ask.test.ts            unit tests for prompt composition
  validate.test.ts       unit tests for the input-validation boundary
  coverage-parsers.test.ts   the three coverage parsers + format detection
  coverage-patch.test.ts     diff parsing, patch intersection, ranking, /source
  coverage-discover.test.ts  discovery, path resolution, project roots
  coverage-merge.test.ts     merging the unit, browser and server LCOV reports
  coverage-server.test.ts    coverage state following the loaded results file
e2e/                     Playwright browser tests (load the compiled dist server)
  coverage-collect.ts    picks the client bundle out of the browser's V8 coverage
coverage-sample/         fixture sources the coverage reports point at. They are
                         C# because the canvas's first audience is .NET: the
                         fixtures mimic a coverlet/Cobertura run, and a fixture
                         written in the language the canvas is written in could
                         pass by resembling the repo rather than a user's
                         project. Outside e2e/ on purpose: anything under a test
                         folder is classified as test code and excluded from
                         ranking.
bench/                   rendering benchmark over generated runs of 100-50,000 tests
scripts/
  typecheck-sdk.ts       checks the pinned SDK against the installed app's copy
  wrap-junit.ts          adds the <testsuite> wrapper node:test omits
  e2e-coverage.ts        runs the e2e suite collecting browser + server coverage
  coverage-report.ts     converts that V8 output to LCOV and merges all three
  lcov.ts                the LCOV read/merge/write itself (pure, unit-tested)
dist/                    compiled JS + .d.ts (committed; regenerate with `npm run build`)
tsconfig.json            type-check config (noEmit)
tsconfig.build.json      build config (emits dist/)
.github/workflows/ci.yml CI: typecheck + build + `node --test` (Node 20 & 22) + e2e + bench
```

## Development

```bash
npm install          # install the TypeScript toolchain + Playwright
npm run build        # compile TypeScript to dist/
npm run typecheck    # type-check without emitting
npm run typecheck:sdk # re-check against the installed app's SDK (see below)
npm test             # run unit tests (via tsx)
npm run test:e2e     # build + run Playwright e2e tests
npm run test:coverage # unit tests + JUnit + LCOV in test-results/, to dogfood the coverage tab
npm run coverage     # the above plus browser + server coverage from the e2e run,
                     # merged into test-results/lcov-merged.info
npm run bench        # build + measure rendering against the perf budgets
```

### Rendering benchmark

`npm run bench` generates synthetic runs, opens them in a real browser and
measures first render, keystroke latency, sorting, filtering, grouping and
scroll pacing against per-scale budgets. It runs 1,000 and 10,000 tests by
default:

```bash
npm run bench                                  # 1,000 and 10,000 tests
BENCH_SCALES=100,1000,10000,50000 npm run bench # every scale
BENCH_SAMPLES=9 npm run bench                   # more samples per measurement
```

Fixtures are generated into `bench/fixtures/` (gitignored) and reused. The list
renders only the rows the viewport is over, so the DOM stays at roughly 150
nodes whether the run has 100 tests or 50,000; the benchmark asserts that too,
which is what stops a change from quietly reintroducing a full rebuild.

Intra-project imports use `.js` specifiers (required by NodeNext ESM); `tsc`, `tsx`,
and Playwright resolve them to the `.ts` sources. After changing any source, run
`npm run build` and commit the updated `dist/` so clones keep working out of the box.

> **Don't delete or rename `extension.mjs`.** The app discovers extensions by
> scanning for that exact filename and never reads `package.json`'s `main`. Without
> it the extension is skipped silently — no error, the panel just never appears.
> Note that the build and test suites all import the code directly, so they pass
> even when discovery is broken.

> **Everything that comes out of a report is untrusted text.** Test names, class
> names, failure messages, coverage file paths and source file contents are all
> attacker-controlled. The client renders them as Preact text nodes and
> attributes, which escape on the way in, so the rule is simply: never reach for
> `dangerouslySetInnerHTML` (or `v-html`, or `{@html}`) to display any of it —
> that reintroduces exactly this bug. Neither that nor direct `innerHTML`
> assignment appears in the codebase today. `e2e/xss.spec.ts` and
> `e2e/coverage-xss.spec.ts` render hostile fixtures and assert that no `on*`
> attribute and no injected element reaches the DOM. Keep them passing.

### `@github/copilot-sdk`

The SDK is a **devDependency**, so `tsc` type-checks against the real published
declarations — there is no hand-written stub. It is dev-only for a reason: at
runtime that copy is never loaded. The Copilot app injects its own bundled SDK
into the extension process through a module resolver hook, so `node_modules` is
used purely for types. End users are unaffected either way, since `dist/` is
committed and they never run `npm install`.

It is a heavy install (the SDK depends on the full `@github/copilot` CLI), which
is the price of type-checking against the genuine contract instead of a mirror
that can quietly go stale.

Because the compile-time SDK and the run-time SDK are two different copies on
two different release cadences, they can drift. `npm run typecheck:sdk`
re-checks the project against the SDK inside your installed Copilot app and
fails if the pinned version no longer agrees with it. Run it before opening a PR
that touches SDK-facing code; on a machine without the app it prints a notice
and exits 0, so it is safe to run anywhere.

## Contributing

Bug reports, feature ideas and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, the checks to run before opening a
PR, and the two invariants that break the extension silently. Participation is
governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

Found a security issue? Please report it privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Alina Haitota

