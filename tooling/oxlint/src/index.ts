import { defineConfig } from "oxlint";

/** Shared Oxlint baseline for Anhur packages and apps. */
export default defineConfig({
  categories: {
    correctness: "error",
  },
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
    "**/node_modules/**",
  ],
});
