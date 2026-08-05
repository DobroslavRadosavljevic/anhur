import { defineConfig } from "tsdown";

/**
 * Library build for publish. Dev keeps JIT `exports` → `src`;
 * built paths land in `publishConfig` (applied by `scripts/release.ts` for Bun).
 */
export default defineConfig({
  entry: {
    index: "./src/index.ts",
    cli: "./src/cli.ts",
  },
  format: "esm",
  dts: true,
  platform: "node",
  // `"type": "module"` → `.js` / `.d.ts` (match markdown/mdx; avoid mixed .mjs/.js).
  fixedExtension: false,
  clean: true,
  exports: {
    devExports: true,
    // CLI is a bin entry, not a public import path.
    exclude: ["cli"],
    bin: {
      anhur: "./src/cli.ts",
    },
  },
});
