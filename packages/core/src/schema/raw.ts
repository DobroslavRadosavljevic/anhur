import { z } from "zod";
import { getDocumentMeta } from "../document-meta";

function isRawString(value: string | undefined): value is string {
  return value !== undefined;
}

/**
 * Document body (or explicit string field) as an unmodified string.
 * When the field is missing, uses the matter loader `content`.
 */
export function raw() {
  return z
    .string()
    .optional()
    .transform((value) => {
      if (isRawString(value)) return value;
      const meta = getDocumentMeta();
      return meta.content ?? "";
    });
}
