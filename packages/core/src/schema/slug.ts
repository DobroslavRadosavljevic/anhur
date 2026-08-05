import { z } from "zod";
import { getDocumentMeta } from "../document-meta";

export type SlugOptions = {
  /**
   * When the field is missing/empty, derive from document id (default)
   * or the file basename without extension.
   */
  from?: "id" | "path";
  /**
   * Strip a trailing `/index` or lone `index` id.
   */
  removeIndex?: boolean;
  /**
   * Validate format. Default: lowercase letters, digits, and hyphens.
   * Pass `false` to skip format checks.
   */
  pattern?: RegExp | false;
};

const DEFAULT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function deriveSlug(options: SlugOptions): string {
  const meta = getDocumentMeta();
  let base =
    options.from === "path"
      ? (meta.path
          .replace(/\\/g, "/")
          .replace(/\.[^./]+$/, "")
          .split("/")
          .pop() ?? "")
      : (meta.id ??
        meta.path
          .replace(/\\/g, "/")
          .replace(/\.[^./]+$/, "")
          .split("/")
          .pop() ??
        "");

  if (options.removeIndex) {
    if (base === "index") base = "";
    else if (base.endsWith("/index")) base = base.slice(0, -"/index".length);
  }

  return base;
}

/**
 * Slug string: keep an explicit value, or derive from the document id/path.
 * Optionally validate a URL-safe pattern.
 */
export function slug(options: SlugOptions = {}) {
  const pattern =
    options.pattern === false
      ? undefined
      : (options.pattern ?? DEFAULT_SLUG_PATTERN);

  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      const resolved =
        typeof value === "string" && value.length > 0
          ? value
          : deriveSlug(options);

      if (!resolved) {
        ctx.addIssue({
          code: "custom",
          message: "slug is empty and could not be derived from the file path",
        });
        return z.NEVER;
      }

      if (pattern && !pattern.test(resolved)) {
        ctx.addIssue({
          code: "custom",
          message: `slug "${resolved}" does not match ${pattern}`,
        });
        return z.NEVER;
      }

      return resolved;
    });
}
