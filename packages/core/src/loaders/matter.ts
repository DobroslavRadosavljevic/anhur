import matter from "gray-matter";
import { defineLoader, type Loader } from "./types";
import { isDocumentFields, type DocumentNode } from "../document-fields";

/**
 * Frontmatter + body for `.md` / `.mdx`.
 */
export function matterLoader(): Loader {
  return defineLoader({
    test: /\.(md|mdx)$/i,
    load({ raw }) {
      const parsed = matter(raw);
      const data: DocumentNode = parsed.data ?? {};
      if (!isDocumentFields(data)) {
        throw new Error("Frontmatter must be a mapping (object).");
      }
      return {
        data,
        content: parsed.content.replace(/^\n/, ""),
      };
    },
  });
}
