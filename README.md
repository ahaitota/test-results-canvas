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

### Option A — install it manually
Clone the repo straight into your user extensions directory so the app discovers it:

```bash
# macOS/Linux
git clone https://github.com/ahaitota/test-results-canvas.git ~/.copilot/extensions/test-results-canvas
```
```powershell
# Windows (PowerShell)
git clone https://github.com/ahaitota/test-results-canvas.git "$env:USERPROFILE\.copilot\extensions\test-results-canvas"
```
### Option B — ask Copilot to install it (haven't tested it yet, but Copilot said it can do this)

In the Copilot app, tell the agent:

> Install the canvas extension at
> `https://github.com/ahaitota/test-results-canvas` and name it `test-results-canvas`

### Step 2:

Restart the app (or run `/clear`) so the extension loads.

### Step 3:

Open any project and ask the agent to run your test suite — the **Test Results**
panel opens on its own as soon as the report is written, and refreshes on each
re-run.

## Files
- `extension.mjs` — entry point: SSE server, canvas registration, and the
  post-tool-use hook that auto-surfaces results.
- `trx.mjs` / `junit.mjs` — TRX and JUnit parsers.
- `view.mjs` — the panel UI (CSS + client rendering/filtering/animation).

