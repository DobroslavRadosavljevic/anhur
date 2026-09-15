import { fromMarkdown } from "mdast-util-from-markdown";
import { toc as extractToc } from "mdast-util-toc";
import type { List, Paragraph, PhrasingContent } from "mdast";
import { Predicate } from "effect";
import { z } from "zod";
import { getDocumentMeta } from "../document-meta";

export type TocEntry = {
  title: string;
  url: string;
  items: TocEntry[];
};

export type TocOptions = {
  /** Heading depth passed to `mdast-util-toc` (e.g. `maxDepth: 3`). */
  maxDepth?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Keep tight lists. */
  tight?: boolean;
};

function isTextValue(node: PhrasingContent): node is PhrasingContent & {
  value: string;
} {
  return "value" in node && Predicate.isString(node.value);
}

function parseParagraph(node: Paragraph): Omit<TocEntry, "items"> {
  const extraction = { title: "", url: "" };
  for (const child of node.children) {
    if (child.type === "link") {
      extraction.url = child.url;
      for (const inner of child.children) {
        if (isTextValue(inner)) {
          extraction.title += inner.value;
        }
      }
    } else if (isTextValue(child)) {
      extraction.title += child.value;
    } else if (child.type === "emphasis" || child.type === "strong") {
      for (const inner of child.children) {
        if (isTextValue(inner)) {
          extraction.title += inner.value;
        }
      }
    }
  }
  return extraction;
}

function asTocList(
  node: List["children"][number]["children"][number] | undefined,
): List | undefined {
  return node?.type === "list" ? node : undefined;
}

function parseList(tree?: List): TocEntry[] {
  if (!tree || tree.type !== "list") return [];
  const layer = tree.children.flatMap((node) => node.children);
  return layer.flatMap((node, index) => {
    if (node.type !== "paragraph") return [];
    return [
      {
        ...parseParagraph(node),
        items: parseList(asTocList(layer[index + 1])),
      },
    ];
  });
}

/**
 * Table of contents from Markdown/MDX body (`meta.content` or field value).
 */
export function toc(options: TocOptions = {}) {
  return z
    .string()
    .optional()
    .transform((value, ctx): TocEntry[] => {
      const meta = getDocumentMeta();
      const source = value ?? meta.content ?? "";
      if (source.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "toc content is empty",
        });
        return z.NEVER;
      }

      try {
        const tree = fromMarkdown(source);
        const result = extractToc(tree, {
          maxDepth: options.maxDepth,
          tight: options.tight,
        });
        return parseList(result.map);
      } catch (err) {
        ctx.addIssue({
          code: "custom",
          message: err instanceof Error ? err.message : String(err),
        });
        return z.NEVER;
      }
    });
}
