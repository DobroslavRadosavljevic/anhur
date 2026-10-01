import { fingerprint, type FieldContext } from "@anhur/core/plugin";
import type { MarkdownOptions } from "./plugin";

/** True when the options hold functions (plugins, `documentLink`). */
function holdsFunctions(options: MarkdownOptions): boolean {
  return (
    options.documentLink !== undefined ||
    (options.remarkPlugins?.length ?? 0) > 0 ||
    (options.rehypePlugins?.length ?? 0) > 0
  );
}

/**
 * Cache key of resolved compile options. Functions are fingerprinted by
 * their source, which does not show the values they close over, so options
 * holding functions also include `context.configFingerprint` (it changes
 * whenever the config or a local module it imports changes).
 */
export function optionsCacheKey(
  options: MarkdownOptions,
  context: FieldContext,
): string {
  return fingerprint([
    options,
    holdsFunctions(options) ? context.configFingerprint : null,
  ]);
}
