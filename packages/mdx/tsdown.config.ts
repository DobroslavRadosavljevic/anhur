import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts", "./src/react/index.tsx"],
  format: "esm",
  dts: true,
  platform: "neutral",
  fixedExtension: false,
  clean: true,
  exports: {
    devExports: true,
  },
});
