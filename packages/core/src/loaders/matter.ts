import matter from "gray-matter";
import { defineLoader, type Loader } from "./types";

/**
 * Frontmatter + body for `.md` / `.mdx`.
 */
export function matterLoader(): Loader {
  return defineLoader({
    test: /\.(md|mdx)$/i,
    load({ raw }) {
      const parsed = matter(raw);
      return {
        data: (parsed.data ?? {}) as Record<string, unknown>,
        content: parsed.content.replace(/^\n/, ""),
      };
    },
  });
}
