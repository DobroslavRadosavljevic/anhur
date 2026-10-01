import type {
  AnhurPlugin,
  DocumentLinkResolver,
  FieldContext,
  PluginSetupContext,
} from "@anhur/core/plugin";
import type { CompileOptions } from "@mdx-js/mdx";
import type { PluggableList } from "unified";
import { optionsCacheKey } from "./cache-key";
import { COMPILER_VERSION, extractMdxHeadings } from "./compile";

/** Plugin name; `m.body()` / `m.mdx()` require it. */
export const MDX_PLUGIN = "mdx";

/** `@mdx-js/mdx` options Anhur passes through. */
export type MdxCompileOptions = Pick<
  CompileOptions,
  | "format"
  | "recmaPlugins"
  | "remarkRehypeOptions"
  | "elementAttributeNameCase"
  | "stylePropertyNameCase"
>;

/** Options of the `mdx()` plugin (and per-field overrides). */
export type MdxOptions = MdxCompileOptions & {
  /** GitHub Flavored Markdown. Default `true`. */
  readonly gfm?: boolean;
  readonly remarkPlugins?: PluggableList;
  /** Run after asset rewriting and heading ids. */
  readonly rehypePlugins?: PluggableList;
  /** Add `id`s to headings, matching `s.toc()` anchors. Default `true`. */
  readonly headingIds?: boolean;
  /** Rewrite links to other pages (`./intro.mdx`, `../guide/`) to public URLs. */
  readonly documentLink?: DocumentLinkResolver;
};

export type MdxPlugin = AnhurPlugin & {
  readonly name: typeof MDX_PLUGIN;
  readonly mdxOptions: MdxOptions;
};

/**
 * `@mdx-js/mdx` options that do nothing or break with the function-body
 * output evaluated by `@anhur/mdx/react`.
 */
const UNSUPPORTED = [
  "development",
  "outputFormat",
  "baseUrl",
  "providerImportSource",
  "jsx",
  "jsxImportSource",
  "jsxRuntime",
  "pragma",
  "pragmaFrag",
  "pragmaImportSource",
];

const UNSUPPORTED_REASON =
  "Anhur compiles MDX to a function body evaluated by @anhur/mdx/react with React's automatic JSX runtime.";

/** Names of unsupported `@mdx-js/mdx` options present in `options`. */
export function unsupportedOptions(options: MdxOptions): string[] {
  return UNSUPPORTED.filter((key) => key in options);
}

/** Throw for unsupported options passed to a field helper (`m.body({ … })`). */
export function assertSupportedOptions(
  options: MdxOptions,
  helper: string,
): void {
  const [key] = unsupportedOptions(options);
  if (key !== undefined) {
    throw new Error(
      `${helper}: option "${key}" is not supported. ${UNSUPPORTED_REASON}`,
    );
  }
}

/**
 * Register MDX compilation: `defineConfig({ plugins: [mdx()] })`.
 *
 * Output is a function-body string (serializable through route loaders),
 * rendered with `@anhur/mdx/react`. MDX is code: it runs at render time on
 * the server and in the browser, so only compile content you trust.
 *
 * Also reports body headings to `s.toc()` (unless `headingIds: false`), so
 * TOC anchors match the ids in the output. The TOC uses these plugin
 * options; per-field options of `m.body()` do not change it.
 */
export function mdx(options: MdxOptions = {}): MdxPlugin {
  const plugin: MdxPlugin = {
    name: MDX_PLUGIN,
    version: "3",
    mdxOptions: options,
    setup: (context: PluginSetupContext) => {
      for (const key of unsupportedOptions(options)) {
        context.error(
          `option "${key}" is not supported: ${UNSUPPORTED_REASON}`,
        );
      }
    },
  };
  if (options.headingIds === false) return plugin;
  return {
    ...plugin,
    headings: {
      key: (context: FieldContext) =>
        `${COMPILER_VERSION};${optionsCacheKey(options, context)}`,
      extract: (body: string, context: FieldContext) =>
        extractMdxHeadings(body, options, context),
    },
  };
}

export function isMdxPlugin(
  plugin: AnhurPlugin | undefined,
): plugin is MdxPlugin {
  return (
    plugin !== undefined && plugin.name === MDX_PLUGIN && "mdxOptions" in plugin
  );
}
