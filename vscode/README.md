# Test Results Canvas for VS Code

Renders .NET TRX and JUnit XML runs as a live panel docked in the sidebar:
pass/fail/skip status, per-test duration, failure messages, search, filtering and
grouping — over runs of tens of thousands of tests.

This is the VS Code host for [test-results-canvas](https://github.com/ahaitota/test-results-canvas).
The parsers, state and UI are shared with the GitHub Copilot app extension at the
root of that repository; only the transport differs. See the repository README
for the architecture and build instructions.

## Features

- **Test Results** view in the activity bar, backed by the shared Preact UI
- watches the workspace for `.trx` / JUnit `.xml` reports and refreshes on every
  run — no command needed
- **Test Results: Open Results File** from the palette or the explorer context menu
- `show_test_results` language model tool, so Copilot Chat can put a run on
  screen and read the failures back (`#testResults`)
- **Ask agent** on a failing row opens Copilot Chat with the question pre-filled

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `testResults.watchGlob` | `**/*.{trx,xml}` | which reports to watch and list |
| `testResults.autoReveal` | `true` | reveal the panel when a report is written |
