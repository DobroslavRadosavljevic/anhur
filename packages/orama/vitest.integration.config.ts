import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "integration",
    environment: "node",
    include: ["tests/integration/**/*.{test,spec}.ts"],
    // A test builds a project several times: slow on a busy CI machine.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
