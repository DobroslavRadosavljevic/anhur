import type { Root } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import {
  collectHtmlAssetUrls,
  collectSrcsetUrls,
  isLinkedAssetAttrName,
  isSrcsetAttrName,
} from "@anhur/core";

function isRelativeAssetUrl(value: string): boolean {
  if (!value || value.trim() === "") return false;
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  return !(
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("#") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("data:") ||
    lower.startsWith("tel:")
  );
}

type UrlHolder = { url?: string };
type JsxAttribute = {
  type: string;
  name?: string;
  value?: string | null;
};
type JsxElement = { attributes?: JsxAttribute[] };
type HtmlNode = { value?: string };

/**
 * Fail when relative body asset URLs appear without an assets() processor.
 */
export const remarkRejectRelativeLinkedFiles: Plugin<[], Root> = () => {
  return (tree, file) => {
    const documentPath = file.path ?? "(unknown file)";
    const found: string[] = [];

    visit(tree, (node) => {
      const type = node.type as string;

      if (type === "link" || type === "image" || type === "definition") {
        const n = node as UrlHolder;
        if (typeof n.url === "string" && isRelativeAssetUrl(n.url)) {
          found.push(n.url);
        }
        return;
      }

      if (type === "html") {
        const n = node as HtmlNode;
        if (typeof n.value === "string") {
          for (const url of collectHtmlAssetUrls(n.value)) {
            if (isRelativeAssetUrl(url)) found.push(url);
          }
        }
        return;
      }

      if (type === "mdxJsxFlowElement" || type === "mdxJsxTextElement") {
        const el = node as unknown as JsxElement;
        for (const attr of el.attributes ?? []) {
          if (attr.type !== "mdxJsxAttribute") continue;
          if (!attr.name || !isLinkedAssetAttrName(attr.name)) continue;
          if (typeof attr.value !== "string") continue;
          if (isSrcsetAttrName(attr.name)) {
            for (const url of collectSrcsetUrls(attr.value)) {
              if (isRelativeAssetUrl(url)) found.push(url);
            }
          } else if (isRelativeAssetUrl(attr.value)) {
            found.push(attr.value);
          }
        }
      }
    });

    if (found.length > 0) {
      const unique = [...new Set(found)];
      throw new Error(
        `Relative assets in content body require an assets() processor. Add assets() from @anhur/assets to defineConfig({ processors }). Found: ${unique.join(", ")} (file: ${documentPath})`,
      );
    }
  };
};
