import { parse as parseYaml } from "yaml";
import { defineLoader, type Loader } from "./types";
import { isDocumentFields, type DocumentNode } from "../document-fields";

/**
 * Whole-file YAML → `data` (no body).
 */
export function yamlLoader(): Loader {
  return defineLoader({
    test: /\.(yaml|yml)$/i,
    load({ raw }) {
      const data: DocumentNode = parseYaml(raw);
      if (!isDocumentFields(data)) {
        throw new Error("YAML root must be a mapping (object).");
      }
      return { data };
    },
  });
}
