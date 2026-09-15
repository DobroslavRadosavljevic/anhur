import type { Root } from "mdast";
import type { Node } from "unist";
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

type JsxAttribute = {
  type: string;
  name?: string;
  value?: string | null;
};

type JsxElement = { attributes?: JsxAttribute[] };

function hasStringUrl(node: Node): node is Node & { url: string } {
  if (!("url" in node)) return false;
  return typeof node.url === "string";
}

function hasStringValue(node: Node): node is Node & { value: string } {
  if (!("value" in node)) return false;
  return typeof node.value === "string";
}

function isJsxElement(node: Node): node is Node & JsxElement {
  return "attributes" in node;
}

function isStringAttrValue(value: JsxAttribute["value"]): value is string {
  return typeof value === "string";
}

/**
 * Fail when relative body asset URLs appear without an assets() processor.
 */
export const remarkRejectRelativeLinkedFiles: Plugin<[], Root> = () => {
  return (tree, file) => {
    const documentPath = file.path ?? "(unknown file)";
    const found: string[] = [];

    visit(tree, (node: Node) => {
      const type = node.type;

      if (type === "link" || type === "image" || type === "definition") {
        if (hasStringUrl(node) && isRelativeAssetUrl(node.url)) {
          found.push(node.url);
        }
        return;
      }

      if (type === "html") {
        if (hasStringValue(node)) {
          for (const url of collectHtmlAssetUrls(node.value)) {
            if (isRelativeAssetUrl(url)) found.push(url);
          }
        }
        return;
      }

      if (type === "mdxJsxFlowElement" || type === "mdxJsxTextElement") {
        if (!isJsxElement(node)) return;
        for (const attr of node.attributes ?? []) {
          if (attr.type !== "mdxJsxAttribute") continue;
          if (!attr.name || !isLinkedAssetAttrName(attr.name)) continue;
          if (!isStringAttrValue(attr.value)) continue;
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
