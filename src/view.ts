// View shell for the Copilot canvas.
//
// This file owns the page CHROME only: the document head, the mount point, and
// the choice of theme block. The stylesheet itself lives in ./styles.ts so the
// VS Code webview can reuse it byte for byte, and the interactive UI is a Preact
// app bundled to dist/client/app.js and loaded via the /client.js route (see
// server.ts). Status colours live in CSS classes keyed off data-theme, so a
// theme flip needs no re-render.
//
// server.ts imports renderShell statically; in dev, `tsc --watch` rebuilds this
// file and `npm run build:client -- --watch` rebuilds the bundle, and extension.ts
// watches both compiled outputs and reloads every open panel — so UI edits appear
// on the next refresh with no extension reload. The stylesheet is passed in by
// server.ts (rather than read from the static import) so that editing styles.ts
// alone still reaches an open panel.

import { THEME_COPILOT, BASE_CSS } from "./styles.js";

export const COPILOT_CSS = THEME_COPILOT + BASE_CSS;

export function renderShell(title: string, askToken = "", css: string = COPILOT_CSS): string {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>${css}</style>
</head>
<body>
  <div id="app"></div>
  <script>window.__INITIAL_TITLE__ = ${JSON.stringify(title)};window.__ASK_TOKEN__ = ${JSON.stringify(askToken)};</script>
  <script type="module" src="/client.js"></script>
</body>
</html>`;
}
