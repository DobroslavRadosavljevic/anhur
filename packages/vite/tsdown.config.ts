import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts"],
  format: "esm",
  // No source maps: they would point at `src/`, which is not published.
  sourcemap: false,
  dts: { sourcemap: false },
  platform: "node",
  fixedExtension: false,
  clean: true,
});
