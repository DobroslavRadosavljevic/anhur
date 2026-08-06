import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts", "./src/client.ts"],
  format: "esm",
  dts: true,
  platform: "node",
  fixedExtension: false,
  clean: true,
  exports: {
    devExports: true,
  },
});
