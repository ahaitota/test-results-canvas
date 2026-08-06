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

## Coverage

A results file records *which tests ran*, never *which code they exercised* —
that comes from a separate report written by a coverage collector during the same
run. The canvas finds that report next to the results it already loaded and adds
a **Coverage** tab beside **Tests**.

| Results loaded | Coverage format it looks for | Produced by |
| --- | --- | --- |
| `.trx` (.NET) | Cobertura XML | `dotnet test --collect:"XPlat Code Coverage"` |
| JUnit `.xml` (Java) | JaCoCo XML | Maven + jacoco-maven-plugin, `gradle jacocoTestReport` |
| JUnit `.xml` (JS/TS, Python, Go, Rust) | LCOV or Cobertura | `vitest --coverage`, `jest --coverage`, `c8`, `nyc`, `pytest --cov --cov-report=xml` |

The format is detected by **content**, not filename, because Cobertura and JaCoCo
both use `.xml` and would otherwise collide with JUnit results.

The tab leads with what is actionable rather than with a project-wide number:

1. **New code** — coverage of just the lines `git` says changed (uncommitted work
   against `HEAD`, or the branch against its merge-base when the tree is clean).
   This is what answers *"the agent wrote new code — did it test it?"*; a repo-wide
   percentage cannot, because forty new untested lines barely move it.
2. **Worth covering** — untested blocks ranked with changed files first, then the
   largest contiguous gaps, skipping tests and generated files.
3. **All files** — grouped by folder, worst first. Expanding any file shows the
   real source with a per-line gutter: green = executed (with its hit count),
   red = executable but never ran, dim = not executable.

When a run produced **no** coverage — by far the most common case, since almost no
runner collects it unless asked — the tab names the exact command for the project
in front of you and offers one click to have the agent re-run with it.

> **The `/source` route serves files by allow-list, never by path filtering.**
> A request is answered only if the resolved path is already present in the loaded
> coverage report, so traversal is impossible by construction rather than by
> sanitising — the same approach `resolveResultPath` takes for results files. The
> "ask agent" prompts are composed server-side from the server's own report; the
> page only ever posts a file reference, gated on the per-instance ask token.
> `git` is spawned with a fixed argument list (never a shell string) inside the
> resolved project root, and its absence degrades to "no New code section" rather
> than an error.


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
  view.ts                panel HTML shell + all CSS
  server.ts              SDK-free HTTP/SSE server, file loading + watching
  ask.ts                 server-side composition of the "ask agent" prompts
  validate.ts            narrows untrusted agent input at the action/open boundary
  labels.ts              file-picker label disambiguation
  rowkey.ts              stable row identity across live payloads
  types.ts               shared TestResult / TestStatus types
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
    CoverageView.tsx     New code -> Worth covering -> All files
    SourceView.tsx       gutter-annotated source for one file
    CoverageEmpty.tsx    the no-coverage state and its ask-agent button
    coverageDerive.ts    pure grouping/percentage/ranking derivations
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
e2e/                     Playwright browser tests (load the compiled dist server)
coverage-sample/         fixture sources the coverage reports point at. Outside
                         e2e/ on purpose: anything under a test folder is
                         classified as test code and excluded from ranking.
scripts/
  typecheck-sdk.ts       checks the pinned SDK against the installed app's copy
  wrap-junit.ts          adds the <testsuite> wrapper node:test omits
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
npm run typecheck:sdk # re-check against the installed app's SDK (see below)
npm test             # run unit tests (via tsx)
npm run test:e2e     # build + run Playwright e2e tests
npm run test:coverage # unit tests + JUnit + LCOV in test-results/, to dogfood the coverage tab
```

To see the coverage tab against this project's own code, run `npm run
test:coverage` and open the canvas on `test-results/unit-junit.xml`; the LCOV
report lands beside it and is discovered automatically. It uses Node's built-in
`--experimental-test-coverage`, so it costs no extra dependency — and it is
worth doing before touching `src/coverage/`, since running the feature on a real
repository is what caught both of the bugs the fixtures could not.

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
> that reintroduces exactly this bug. `e2e/xss.spec.ts` and
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

