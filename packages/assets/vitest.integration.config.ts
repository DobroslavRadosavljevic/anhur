import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "integration",
    environment: "node",
    include: ["tests/integration/**/*.{test,spec}.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
