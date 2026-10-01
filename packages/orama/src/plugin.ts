import type { AnyContent } from "@anhur/core";
import { defineContentPlugin } from "@anhur/core/plugin";
import { generateSearchModules, type RuntimeOramaOptions } from "./build";
import type {
  OramaOptions,
  OramaPlugin,
  OramaPluginName,
  SearchCollections,
  StoresOf,
} from "./types";

/**
 * Full-text search with Orama, built with the content:
 *
 * ```ts
 * defineConfig({
 *   content: [posts],
 *   plugins: [
 *     orama({
 *       collections: {
 *         posts: {
 *           schema: { title: "string", tags: "string[]" },
 *           index: (doc) => ({ title: doc.title, tags: doc.tags }),
 *           store: (doc) => ({ title: doc.title, href: `/posts/${doc.slug}` }),
 *         },
 *       },
 *     }),
 *   ],
 * });
 * ```
 *
 * `index()` must return exactly the `schema` fields (checked by TypeScript
 * and again at build time; `undefined` leaves a field out). Generates one
 * index per locale and `loadSearchIndex(locale)` in `anhur/generated`;
 * search it with `createSearcher()` from `@anhur/orama/client`. Hits are
 * typed with each collection's `store()` return type.
 */
export function orama<
  TContent extends readonly AnyContent[],
  const TCollections extends SearchCollections<TContent>,
>(
  options: OramaOptions<NoInfer<TContent>, TCollections>,
): OramaPlugin<TContent, StoresOf<TCollections>> {
  // SAFETY: the collections were type-checked against the content tuple; at runtime only `schema`, `index` and `store` are read (and validated).
  const runtime = options as RuntimeOramaOptions;
  // SAFETY: the name is "orama" at runtime; the brand on its type is a phantom (type-only) carrier of the store types.
  const name = "orama" as OramaPluginName<StoresOf<TCollections>>;
  return defineContentPlugin<TContent, OramaPluginName<StoresOf<TCollections>>>(
    () => ({
      name,
      version: "4",
      generate: (context) => generateSearchModules(runtime, context),
    }),
  );
}
