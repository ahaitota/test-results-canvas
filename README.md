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
extension.mjs            discovery entry point — the Copilot app scans for this
                         exact filename (it ignores package.json "main"). One
                         line: it imports dist/extension.js. Never edit.
extension.ts             the real entry point source (compiled to dist/extension.js)
src/
  view.ts                HTML shell served to the Copilot panel (no result rendering)
  styles.ts              the stylesheet, shared by both hosts (Copilot + VS Code themes)
  server.ts              SDK-free HTTP/SSE transport for the Copilot canvas
  core/
    store.ts             host-free state: discovery, parsing, watching, mutation
  validate.ts            narrows untrusted agent input at the action/open boundary
  labels.ts              file-picker label disambiguation
  types.ts               shared TestResult / TestStatus / CanvasState types
  client/                Preact UI bundled to dist/client/app.js by esbuild
    main.tsx             client entry point
    App.tsx              root component, wires up state and the results stream
    bridge.ts            the host seam the UI imports as "@bridge" (types only)
    bridge.sse.ts        Copilot implementation of the bridge (EventSource + fetch)
    Toolbar.tsx          filter/search controls
    Summary.tsx          pass/fail/skip totals
    ResultsList.tsx      the list of results (renders only the visible window)
    TestRow.tsx          one result row, including failure detail
    virtual.ts           windowing: flattens the list and tracks row heights
    useResultsStream.ts  bridge subscription that drives live refresh
  parsers/
    trx.ts               .NET TRX parser
    junit.ts             JUnit XML parser
vscode/                  the VS Code extension (same store, same UI, different host)
  package.json           manifest: sidebar view, commands, language model tool
  src/extension.ts       activate(): WebviewViewProvider + file watcher + lm tool
  src/client/
    bridge.vscode.ts     VS Code implementation of the bridge (postMessage)
test/
  trx.test.ts            unit tests for the TRX parser
  junit.test.ts          unit tests for the JUnit parser
  labels.test.ts         unit tests for the label generator
  validate.test.ts       unit tests for the input-validation boundary
e2e/                     Playwright browser tests (load the compiled dist server)
bench/                   rendering benchmark over generated runs of 100-50,000 tests
scripts/
  typecheck-sdk.ts       checks the pinned SDK against the installed app's copy
  wrap-junit.ts          adds the <testsuite> wrapper node:test omits
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
npm run bench        # build + measure rendering against the perf budgets
```

## VS Code extension

The same parsers, state and Preact UI also run as a VS Code extension that docks
in the sidebar like Copilot Chat. Only the host differs:

| | Copilot app | VS Code |
| --- | --- | --- |
| host glue | `extension.ts` + `src/server.ts` | `vscode/src/extension.ts` |
| transport | HTTP + SSE on loopback | webview `postMessage` |
| bridge | `src/client/bridge.sse.ts` | `vscode/src/client/bridge.vscode.ts` |
| theme | `THEME_COPILOT` | `THEME_VSCODE` (`--vscode-*` tokens) |

The UI imports the transport as `@bridge`; each build swaps in one implementation
with [esbuild's `--alias`](https://esbuild.github.io/api/#alias), so neither host
ever ships the other's code. Everything below `@bridge` — `src/core/store.ts`,
`src/parsers/`, `src/client/` and `src/styles.ts` — is shared verbatim.

```bash
npm run build:vscode   # bundle the host (CJS) + the webview UI (IIFE) into vscode/dist
npm run typecheck:vscode
```

Then press <kbd>F5</kbd> (**Run VS Code extension**) to launch an Extension
Development Host with it loaded, or package it:

```bash
npx @vscode/vsce package --no-dependencies   # run inside vscode/
code --install-extension test-results-canvas-vscode-0.1.0.vsix
```

What it adds on the VS Code side:

- a **Test Results** container in the activity bar holding a webview view, so the
  panel docks in the sidebar (and can be dragged to the secondary side bar)
- a workspace file watcher on `testResults.watchGlob` (default `**/*.{trx,xml}`),
  so a run written by any terminal or task refreshes the panel — and reveals it,
  unless `testResults.autoReveal` is off
- **Test Results: Open Results File** in the command palette and on the explorer
  context menu for `.trx`/`.xml`
- a `show_test_results` language model tool, so the agent can put a run on screen
  and read the failures back; reference it in chat with `#testResults`
- **Ask agent** on a failing row opens Copilot Chat with the question pre-filled


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

> **Never render result-file text as raw HTML.** Test names, class names and
> failure messages are attacker-controlled — a name containing a quote or angle
> bracket is a live injection attempt. The UI is built from Preact components in
> `src/client/`, which escape interpolated text and attribute values
> automatically, so the safe path is simply to render the value and let Preact
> handle it. The ways to break that are `dangerouslySetInnerHTML` and direct
> `innerHTML` assignment; neither appears in the codebase today, and neither
> should be added for result-file content. `e2e/xss.spec.ts` renders a hostile
> fixture and asserts no `on*` attributes reach the DOM — keep it passing.

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

