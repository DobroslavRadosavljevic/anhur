import { z } from "zod";
import { getDocumentMeta } from "../document-meta";

/**
 * Document body (or explicit string field) as an unmodified string.
 * When the field is missing, uses the matter loader `content`.
 */
export function raw() {
  return z
    .string()
    .optional()
    .transform((value) => {
      if (typeof value === "string") return value;
      const meta = getDocumentMeta();
      return meta.content ?? "";
    });
}
