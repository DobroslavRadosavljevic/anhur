import { parse as parseYaml } from "yaml";
import { defineLoader, type Loader } from "./types";

/**
 * Whole-file YAML → `data` (no body).
 */
export function yamlLoader(): Loader {
  return defineLoader({
    test: /\.(yaml|yml)$/i,
    load({ raw }) {
      const data = parseYaml(raw);
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("YAML root must be a mapping (object).");
      }
      return { data: data as Record<string, unknown> };
    },
  });
}
