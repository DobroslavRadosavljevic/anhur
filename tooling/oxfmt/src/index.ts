import { defineConfig } from "oxfmt";

/** Shared Oxfmt baseline for Anhur packages and apps. */
export default defineConfig({
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  jsxSingleQuote: false,
  trailingComma: "all",
  arrowParens: "always",
  endOfLine: "lf",
  ignorePatterns: [
    "**/dist/**",
    "**/coverage/**",
    "**/build/**",
    "**/.output/**",
    "**/.nitro/**",
    "**/.turbo/**",
    "**/.anhur/**",
    "**/.temp/**",
    "**/.tanstack/**",
    "**/routeTree.gen.ts",
    "**/bun.lock",
    "**/node_modules/**",
  ],
});
