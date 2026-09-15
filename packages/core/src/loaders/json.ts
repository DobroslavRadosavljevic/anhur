import { defineLoader, type Loader } from "./types";
import { isDocumentFields, type DocumentNode } from "../document-fields";

/**
 * Whole-file JSON → `data` (no body).
 */
export function jsonLoader(): Loader {
  return defineLoader({
    test: /\.json$/i,
    load({ raw }) {
      const data: DocumentNode = JSON.parse(raw);
      if (!isDocumentFields(data)) {
        throw new Error("JSON root must be an object.");
      }
      return { data };
    },
  });
}
