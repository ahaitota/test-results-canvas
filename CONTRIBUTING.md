# Contributing

Thanks for your interest in improving the Test Results canvas. Bug reports,
feature ideas and pull requests are all welcome.

## Getting set up

You need Node `^20.19.0 || >=22.12.0`.

```bash
git clone https://github.com/ahaitota/test-results-canvas.git
cd test-results-canvas
npm install
npm run build
```

To try your changes in the Copilot app, point the app's extensions directory at
your checkout — either clone directly into it, or symlink:

```bash
# macOS/Linux
ln -s "$PWD" ~/.copilot/extensions/test-results-canvas
```
```powershell
# Windows (PowerShell)
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.copilot\extensions\test-results-canvas" -Target $PWD
```

Restart the app (or run `/clear`) so the extension is re-discovered.

## Before you open a pull request

Run the full local check set:

```bash
npm run lint
npm run typecheck
npm run typecheck:client
npm run typecheck:e2e
npm test
npm run test:e2e
```

If your change touches SDK-facing code, also run `npm run typecheck:sdk`. It
re-checks the project against the SDK bundled with your installed Copilot app
and catches drift between the pinned devDependency and the runtime copy. On a
machine without the app installed it prints a notice and exits 0.

**Commit the rebuilt `dist/`.** The compiled output is intentionally checked in
so end users can clone and run the extension with no build step. Any source
change must ship with the regenerated `dist/` from `npm run build`, or clones
will silently run stale code.

## Things that will break the extension

Two invariants are easy to violate and fail quietly — the build and tests both
pass while the extension is broken. They are documented at length in the README,
but in short:

- **Never delete or rename `extension.mjs`.** The app discovers extensions by
  scanning for that exact filename and ignores `package.json`'s `main`. Without
  it the extension is skipped with no error.
- **Never render result-file text as raw HTML.** Test names, class names and
  failure messages are attacker-controlled. The UI is built from Preact
  components in `src/client/`, which escape interpolated text automatically, so
  the safe path is the default one — just render the value. Introducing
  `dangerouslySetInnerHTML` (or assigning to `innerHTML`) reintroduces the
  injection bug. `e2e/xss.spec.ts` renders a hostile fixture and asserts no
  `on*` attributes reach the DOM — keep it passing.

## Pull request expectations

- Keep changes focused; unrelated refactors make review harder.
- Add or update tests for behaviour changes. Parser changes belong in
  `test/`, rendering and interaction changes in `e2e/`.
- Update the README when you change install steps, project layout or
  supported report formats.
- CI runs lint, typecheck, unit tests on Node 20 and 22, and the Playwright
  e2e suite. It must be green before merge.

## Reporting bugs

Open an issue using the bug report template. A failing `.trx` or JUnit `.xml`
report attached to the issue is by far the most useful thing you can include —
scrub anything sensitive from it first.

## Security

Do not open a public issue for a security vulnerability. See
[SECURITY.md](SECURITY.md) for how to report one privately.
