## What does this change?

<!-- A short description of the change and why it is needed. -->

Closes #

## How was it tested?

<!-- Describe the tests you added or the manual verification you did. -->

## Checklist

- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run test:e2e` passes
- [ ] Tests added or updated for the changed behaviour
- [ ] `npm run build` was run and the updated `dist/` is committed
- [ ] README updated if install steps, project layout or supported formats changed
- [ ] `npm run typecheck:sdk` was run (only if this touches SDK-facing code)

<!--
Reminders:
  - Do not delete or rename `extension.mjs` — the app discovers extensions by
    that exact filename and fails silently without it.
  - All text from result files must go through `esc()` in `src/view.ts`.
-->
