import { fingerprint, type FieldContext } from "@anhur/core/plugin";
import type { MdxOptions } from "./plugin";

/** True when the options hold functions (plugins, handlers, `documentLink`). */
function holdsFunctions(options: MdxOptions): boolean {
  const remarkRehype = options.remarkRehypeOptions;
  return (
    options.documentLink !== undefined ||
    (options.remarkPlugins?.length ?? 0) > 0 ||
    (options.rehypePlugins?.length ?? 0) > 0 ||
    (options.recmaPlugins?.length ?? 0) > 0 ||
    remarkRehype?.handlers !== undefined ||
    remarkRehype?.unknownHandler !== undefined
  );
}

/**
 * Cache key of resolved compile options. Functions are fingerprinted by
 * their source, which does not show the values they close over, so options
 * holding functions also include `context.configFingerprint` (it changes
 * whenever the config or a local module it imports changes).
 */
export function optionsCacheKey(
  options: MdxOptions,
  context: FieldContext,
): string {
  return fingerprint([
    options,
    holdsFunctions(options) ? context.configFingerprint : null,
  ]);
}
