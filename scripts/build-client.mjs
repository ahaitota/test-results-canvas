// Bundles the Preact browser client into dist/client/app.js.
// Plain .mjs so it runs without a build step; not part of the Node tsconfig.
import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const options = {
  entryPoints: [join(root, "src", "client", "main.tsx")],
  outfile: join(root, "dist", "client", "app.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  minify: true,
  sourcemap: false,
  logLevel: "info",
};

const watch = process.argv.includes("--watch");

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("build-client: watching src/client for changes");
} else {
  await build(options);
}
