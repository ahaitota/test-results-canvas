// Preact browser client entry: init theme, then mount the app.
import { render } from "preact";
import { App } from "./App";
import { initTheme } from "./theme";

initTheme();
const root = document.getElementById("app");
if (root) render(<App />, root);
