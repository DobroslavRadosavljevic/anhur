import type { Root } from "mdast";
import type { Node } from "unist";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import {
  collectHtmlAssetUrls,
  collectSrcsetUrls,
  isLinkedAssetAttrName,
  isSrcsetAttrName,
  mapSrcsetUrls,
  rewriteHtmlAssetAttrValue,
} from "@anhur/core";
import {
  isRelativeAssetUrl,
  requireAssetsProcessor,
  resolveAndEmit,
} from "./resolve";

type JsxAttribute = {
  type: string;
  name?: string;
  value?: string | null | { type?: string; value?: string };
};

type JsxElement = {
  type: string;
  attributes?: JsxAttribute[];
};

type Rewrite = (next: string) => void;

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

function collectRelativeRewrites(tree: Root): Map<string, Rewrite[]> {
  const byUrl = new Map<string, Rewrite[]>();

  const register = (url: string, rewrite: Rewrite) => {
    if (!isRelativeAssetUrl(url)) return;
    const list = byUrl.get(url) ?? [];
    list.push(rewrite);
    byUrl.set(url, list);
  };

  visit(tree, (node: Node) => {
    const type = node.type;

    if (type === "link" || type === "image" || type === "definition") {
      if (hasStringUrl(node)) {
        const n = node;
        register(n.url, (next) => {
          n.url = next;
        });
      }
      return;
    }

    if (type === "html") {
      if (!hasStringValue(node)) return;
      const n = node;
      for (const url of collectHtmlAssetUrls(n.value)) {
        register(url, (next) => {
          if (!hasStringValue(n)) return;
          n.value = rewriteHtmlAssetAttrValue(n.value, url, next);
        });
      }
      return;
    }

    if (type === "mdxJsxFlowElement" || type === "mdxJsxTextElement") {
      if (!isJsxElement(node)) return;
      const el = node;
      for (const attr of el.attributes ?? []) {
        if (attr.type !== "mdxJsxAttribute") continue;
        if (!attr.name || !isLinkedAssetAttrName(attr.name)) continue;
        if (!isStringAttrValue(attr.value)) continue;
        const attrName = attr.name;
        const current = attr.value;
        if (isSrcsetAttrName(attrName)) {
          for (const url of collectSrcsetUrls(current)) {
            register(url, (next) => {
              if (!isStringAttrValue(attr.value)) return;
              attr.value = mapSrcsetUrls(attr.value, (candidate) =>
                candidate === url ? next : candidate,
              );
            });
          }
        } else {
          register(current, (next) => {
            attr.value = next;
          });
        }
      }
    }
  });

  return byUrl;
}

function documentPathFromFile(file: { path?: string }): string {
  if (file.path) return file.path;
  throw new Error(
    "remarkCopyLinkedFiles requires a document path (compile with filePath).",
  );
}

/**
 * Copy relative linked files into the assets dir and rewrite URLs to public `src`.
 * Requires `assets()` in `defineConfig({ processors })`.
 */
export const remarkCopyLinkedFiles: Plugin<[], Root> = () => {
  return async (tree, file) => {
    const documentPath = documentPathFromFile(file);
    requireAssetsProcessor(documentPath);

    const byUrl = collectRelativeRewrites(tree);

    await Promise.all(
      [...byUrl.entries()].map(async ([url, rewrites]) => {
        const publicUrl = await resolveAndEmit(url, documentPath);
        for (const rewrite of rewrites) {
          rewrite(publicUrl);
        }
      }),
    );
  };
};

/**
 * Fail the build when relative asset URLs appear and `assets()` is not registered.
 */
export const remarkRejectRelativeLinkedFiles: Plugin<[], Root> = () => {
  return (tree, file) => {
    const documentPath = file.path ?? "(unknown file)";
    const byUrl = collectRelativeRewrites(tree);
    if (byUrl.size === 0) return;

    const unique = [...byUrl.keys()];
    throw new Error(
      `Relative assets in content body require an assets() processor. Add assets() from @anhur/assets to defineConfig({ processors }). Found: ${unique.join(", ")} (file: ${documentPath})`,
    );
  };
};
