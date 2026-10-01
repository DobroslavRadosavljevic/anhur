import { Predicate } from "effect";
import type { AnyContent } from "../define/types";
import type { AnhurPlugin, ContentPlugin, Loader, PluginInput } from "./types";

/** Identity helper that types a plugin object. */
export function definePlugin<TPlugin extends AnhurPlugin>(
  plugin: TPlugin,
): TPlugin {
  return plugin;
}

/** Identity helper that types a loader. */
export function defineLoader(loader: Loader): Loader {
  return loader;
}

/**
 * Build a plugin entry typed against the config's content tuple. `create`
 * runs when the config is resolved.
 *
 * @example
 * ```ts
 * export function search<TContent extends readonly AnyContent[]>(
 *   options: NoInfer<SearchOptions<TContent>>,
 * ): ContentPlugin<TContent, "search"> {
 *   return defineContentPlugin(() => ({ name: "search", generate: … }));
 * }
 * ```
 */
export function defineContentPlugin<
  TContent extends readonly AnyContent[],
  TName extends string,
>(
  create: () => AnhurPlugin & { readonly name: TName },
): ContentPlugin<TContent, TName> {
  // SAFETY: the content / resolver keys are phantom (type-only); at runtime the entry is a zero-argument factory.
  return create as ContentPlugin<TContent, TName>;
}

/** Turn a `plugins` entry into its plugin object. */
export function resolvePluginInput(
  input: PluginInput<readonly AnyContent[]>,
): AnhurPlugin {
  return Predicate.isFunction(input) ? input() : input;
}
