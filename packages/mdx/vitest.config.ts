import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: ["./vitest.unit.config.ts", "./vitest.integration.config.ts"],
  },
});
