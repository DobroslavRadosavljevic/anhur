import { z } from "zod";
import { getDocumentMeta } from "../document-meta";
import { toPlainText } from "./plain-text";

export type ExcerptOptions = {
  /** Max characters. Default `260`. */
  length?: number;
};

/**
 * Plain-text excerpt from the field value or document body (`meta.content`).
 */
export function excerpt(options: ExcerptOptions = {}) {
  const length = options.length ?? 260;

  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      const meta = getDocumentMeta();
      const source = value ?? meta.content ?? "";
      if (source.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "excerpt content is empty",
        });
        return z.NEVER;
      }
      const plain = toPlainText(source);
      if (plain.length <= length) return plain;
      return `${plain.slice(0, length).trimEnd()}…`;
    });
}
