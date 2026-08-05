/**
 * Opaque processor plugin registered via `defineConfig({ processors })`.
 * Packages provide factories (`mdx()`, `markdown()`, `assets()`, …);
 * core does not interpret `options`.
 */
export type ProcessorPlugin<TOptions = unknown> = {
  readonly id: string;
  readonly options: TOptions;
};

export function defineProcessor<TOptions>(
  id: string,
  options: TOptions,
): ProcessorPlugin<TOptions> {
  return { id, options };
}

export function findProcessor(
  processors: readonly ProcessorPlugin[] | undefined,
  id: string,
): ProcessorPlugin | undefined {
  return processors?.find((p) => p.id === id);
}
