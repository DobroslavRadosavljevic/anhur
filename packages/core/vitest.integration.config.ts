import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "integration",
    environment: "node",
    include: ["tests/integration/**/*.{test,spec}.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
