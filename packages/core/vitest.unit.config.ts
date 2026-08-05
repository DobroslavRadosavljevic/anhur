import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "unit",
    environment: "node",
    include: ["tests/unit/**/*.{test,spec}.ts"],
  },
});
