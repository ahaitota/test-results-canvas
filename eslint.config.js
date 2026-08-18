// Lint config. Types are tsc's job (see the typecheck:* scripts); this covers
// correctness rules and the readability ones -- one statement per line, and
// braces on any block that wraps onto a second line.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import stylistic from "@stylistic/eslint-plugin";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "vscode/dist/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "extension.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "@stylistic": stylistic },
    rules: {
      // TypeScript already resolves identifiers; no-undef only adds false positives.
      "no-undef": "off",
      curly: ["error", "multi-line"],
      eqeqeq: ["error", "smart"],
      "@stylistic/max-statements-per-line": ["error", { max: 1 }],
    },
  },
);
