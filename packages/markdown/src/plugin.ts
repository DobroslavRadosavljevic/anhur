import type {
  AnhurPlugin,
  DocumentLinkResolver,
  FieldContext,
} from "@anhur/core/plugin";
import type { Options } from "rehype-sanitize";
import type { PluggableList } from "unified";
import { optionsCacheKey } from "./cache-key";
import {
  COMPILER_VERSION,
  compileMarkdownWithHeadings,
  extractMarkdownHeadings,
} from "./compile";

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

/** Plugin options, then field options on top (plugin lists run first). */
export function resolveOptions(
  context: FieldContext,
  field: MarkdownOptions,
): MarkdownOptions {
  const plugin = context.getPlugin(MARKDOWN_PLUGIN);
  const base = isMarkdownPlugin(plugin) ? plugin.markdownOptions : {};
  return {
    gfm: field.gfm ?? base.gfm,
    allowDangerousHtml: field.allowDangerousHtml ?? base.allowDangerousHtml,
    sanitizeSchema: field.sanitizeSchema ?? base.sanitizeSchema,
    headingIds: field.headingIds ?? base.headingIds,
    documentLink: field.documentLink ?? base.documentLink,
    remarkPlugins: [
      ...(base.remarkPlugins ?? []),
      ...(field.remarkPlugins ?? []),
    ],
    rehypePlugins: [
      ...(base.rehypePlugins ?? []),
      ...(field.rehypePlugins ?? []),
    ],
  };
}

/**
 * Key under which the compiled document body is shared between the fields
 * of a document (`context.share`): `md.body()` and `s.toc()` with the same
 * options compile the body once.
 */
export function bodyShareKey(
  resolved: MarkdownOptions,
  context: FieldContext,
): string {
  return `markdown:body:${optionsCacheKey(resolved, context)}`;
}

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
      extract: async (body: string, context: FieldContext) => {
        // `md.body()` with these options compiles the same body: take the
        // headings it finds instead of compiling a second time.
        const resolved = resolveOptions(context, {});
        const key = bodyShareKey(resolved, context);
        if (context.isShared(key)) {
          try {
            const compiled = await context.share(key, (shared) =>
              compileMarkdownWithHeadings(body, resolved, shared),
            );
            return compiled.headings;
          } catch {
            // The body field reports the problem; the TOC need not fail too.
          }
        }
        return extractMarkdownHeadings(body, options, context);
      },
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
