import { z } from "zod";
import type { DocumentFields } from "../document-fields";
import { getBuildContext } from "../build-context";
import { getDocumentMeta } from "../document-meta";

export type UniqueOptions = {
  /**
   * - `locale` — unique within collection + locale (default when localized)
   * - `collection` — unique across all locales of this collection
   * - `project` — unique across the whole project (use `group`)
   */
  scope?: "locale" | "collection" | "project";
  /** Cache group name (especially for `scope: "project"`). Default: `"default"`. */
  group?: string;
};

function isDraftInput(input: unknown): input is DocumentFields & {
  draft: true;
} {
  return (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    "draft" in input &&
    input.draft === true
  );
}

/**
 * Ensure a string field is unique within the chosen scope for this build.
 */
export function unique(options: UniqueOptions = {}) {
  return z.string().superRefine((value, ctx) => {
    const meta = getDocumentMeta();
    // Drafts are omitted after collect; they must not occupy unique slots.
    if (isDraftInput(meta.input)) return;
    const build = getBuildContext();
    const group = options.group ?? "default";
    const scope =
      options.scope ?? (meta.locale !== undefined ? "locale" : "collection");

    let key: string;
    if (scope === "project") {
      key = `unique:project:${group}:${value}`;
    } else if (scope === "collection") {
      key = `unique:collection:${meta.sourceName}:${group}:${value}`;
    } else {
      key = `unique:locale:${meta.sourceName}:${meta.locale ?? ""}:${group}:${value}`;
    }

    const conflict = build.cache.get(key);
    if (conflict) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate value "${value}" in "${meta.path}" (conflicts with "${conflict}")`,
      });
      return;
    }

    build.cache.set(key, meta.path);
  });
}
