import { defineLoader, type Loader } from "./types";

/**
 * Whole-file JSON → `data` (no body).
 */
export function jsonLoader(): Loader {
  return defineLoader({
    test: /\.json$/i,
    load({ raw }) {
      const data = JSON.parse(raw) as unknown;
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("JSON root must be an object.");
      }
      return { data: data as Record<string, unknown> };
    },
  });
}
