import type {
  AnhurPlugin,
  DocumentLinkResolver,
  FieldContext,
} from "@anhur/core/plugin";
import type { Options } from "rehype-sanitize";
import type { PluggableList } from "unified";
import { optionsCacheKey } from "./cache-key";
import { COMPILER_VERSION, extractMarkdownHeadings } from "./compile";

/** Plugin name; `md.body()` / `md.markdown()` require it. */
export const MARKDOWN_PLUGIN = "markdown";

/** A `rehype-sanitize` schema. */
export type SanitizeSchema = Options;

/** Options of the `markdown()` plugin (and per-field overrides). */
export type MarkdownOptions = {
  /** GitHub Flavored Markdown (tables, task lists, strikethrough, footnotes). Default `true`. */
  readonly gfm?: boolean;
  /** Extra remark plugins (run on the Markdown tree, before HTML exists). */
  readonly remarkPlugins?: PluggableList;
  /**
   * Extra rehype plugins. They run **after** sanitizing, asset rewriting and
   * heading ids, on the final HTML tree: anything they add (raw HTML,
   * `style`, event handlers, URLs) is not sanitized and relative URLs they
   * add are not copied. Only use plugins you trust to emit safe HTML.
   */
  readonly rehypePlugins?: PluggableList;
  /**
   * Keep raw HTML exactly as written (no sanitizing). Only for content you
   * fully trust: it allows `<script>` and event handlers. Default `false`.
   */
  readonly allowDangerousHtml?: boolean;
  /**
   * Custom `rehype-sanitize` schema. Default: {@link DEFAULT_SANITIZE_SCHEMA}
   * (GitHub's schema plus `<video>`, `<audio>`, `<source>`, `<track>`,
   * `<picture>` and responsive `<img>`).
   */
  readonly sanitizeSchema?: SanitizeSchema;
  /** Add `id`s to headings, matching `s.toc()` anchors. Default `true`. */
  readonly headingIds?: boolean;
  /** Rewrite links to other pages (`./intro.md`, `../guide/`) to public URLs. */
  readonly documentLink?: DocumentLinkResolver;
};

/** The registered plugin; fields read its options through the field context. */
export type MarkdownPlugin = AnhurPlugin & {
  readonly name: typeof MARKDOWN_PLUGIN;
  readonly markdownOptions: MarkdownOptions;
};

/**
 * Register Markdown → HTML compilation: `defineConfig({ plugins: [markdown()] })`.
 *
 * Also reports body headings to `s.toc()` (unless `headingIds: false`), so
 * TOC anchors match the ids in the HTML. The TOC uses these plugin options;
 * per-field options of `md.body()` do not change it.
 */
export function markdown(options: MarkdownOptions = {}): MarkdownPlugin {
  const plugin: MarkdownPlugin = {
    name: MARKDOWN_PLUGIN,
    version: "3",
    markdownOptions: options,
  };
  if (options.headingIds === false) return plugin;
  return {
    ...plugin,
    headings: {
      key: (context: FieldContext) =>
        `${COMPILER_VERSION};${optionsCacheKey(options, context)}`,
      extract: (body: string, context: FieldContext) =>
        extractMarkdownHeadings(body, options, context),
    },
  };
}

export function isMarkdownPlugin(
  plugin: AnhurPlugin | undefined,
): plugin is MarkdownPlugin {
  return (
    plugin !== undefined &&
    plugin.name === MARKDOWN_PLUGIN &&
    "markdownOptions" in plugin
  );
}
