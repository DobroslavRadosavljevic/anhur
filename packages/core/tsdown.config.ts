import { defineConfig } from "tsdown";

/**
 * Library build for publish. In the workspace, `exports` point at `src`;
 * the release script swaps in `publishConfig.exports` (dist).
 */
export default defineConfig({
  entry: {
    index: "./src/index.ts",
    build: "./src/build/index.ts",
    plugin: "./src/plugin/index.ts",
    cli: "./src/cli/main.ts",
    // Started by the engine as a worker thread (`worker.js` next to it).
    worker: "./src/worker/validation.ts",
  },
  format: "esm",
  // No source maps: they would point at `src/`, which is not published.
  sourcemap: false,
  dts: { sourcemap: false },
  platform: "node",
  fixedExtension: false,
  clean: true,
});
