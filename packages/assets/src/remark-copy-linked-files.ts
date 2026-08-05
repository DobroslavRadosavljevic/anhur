import type { Root } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import {
  isRelativeAssetUrl,
  requireAssetsProcessor,
  resolveAndEmit,
} from "./resolve";

const LINKED_ATTR_NAMES = new Set(["href", "src", "poster"]);

type UrlHolder = { url?: string };

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

function collectRelativeRewrites(tree: Root): Map<string, Rewrite[]> {
  const byUrl = new Map<string, Rewrite[]>();

  const register = (url: string, rewrite: Rewrite) => {
    if (!isRelativeAssetUrl(url)) return;
    const list = byUrl.get(url) ?? [];
    list.push(rewrite);
    byUrl.set(url, list);
  };

  visit(tree, (node) => {
    const type = node.type as string;

    if (type === "link" || type === "image" || type === "definition") {
      const n = node as UrlHolder;
      if (typeof n.url === "string") {
        register(n.url, (next) => {
          n.url = next;
        });
      }
      return;
    }

    if (type === "mdxJsxFlowElement" || type === "mdxJsxTextElement") {
      const el = node as unknown as JsxElement;
      for (const attr of el.attributes ?? []) {
        if (attr.type !== "mdxJsxAttribute") continue;
        if (!attr.name || !LINKED_ATTR_NAMES.has(attr.name)) continue;
        // String literal only — skip src={expr}
        if (typeof attr.value === "string") {
          register(attr.value, (next) => {
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
