import type { Root } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

const LINKED_ATTR_NAMES = new Set(["href", "src", "poster"]);

function isRelativeAssetUrl(value: string): boolean {
  if (!value || value.trim() === "") return false;
  return !(
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("//") ||
    value.startsWith("/") ||
    value.startsWith("#") ||
    value.startsWith("mailto:") ||
    value.startsWith("data:") ||
    value.startsWith("tel:")
  );
}

type UrlHolder = { url?: string };
type JsxAttribute = {
  type: string;
  name?: string;
  value?: string | null;
};
type JsxElement = { attributes?: JsxAttribute[] };

/**
 * Fail when relative body asset URLs appear without an assets() processor.
 * Kept local so MDX/Markdown fail-fast without importing @anhur/assets.
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

      if (type === "mdxJsxFlowElement" || type === "mdxJsxTextElement") {
        const el = node as unknown as JsxElement;
        for (const attr of el.attributes ?? []) {
          if (attr.type !== "mdxJsxAttribute") continue;
          if (!attr.name || !LINKED_ATTR_NAMES.has(attr.name)) continue;
          if (
            typeof attr.value === "string" &&
            isRelativeAssetUrl(attr.value)
          ) {
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
