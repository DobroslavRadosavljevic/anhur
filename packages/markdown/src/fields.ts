import {
  defineField,
  type FieldContext,
  type FieldInput,
} from "@anhur/core/plugin";
import { z } from "zod";
import { optionsCacheKey } from "./cache-key";
import { COMPILER_VERSION, compileMarkdown } from "./compile";
import {
  MARKDOWN_PLUGIN,
  isMarkdownPlugin,
  type MarkdownOptions,
} from "./plugin";

function isString(value: FieldInput): value is string {
  return typeof value === "string";
}

/** Plugin options, then field options on top (plugin lists run first). */
function resolveOptions(
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

function cacheOf(field: MarkdownOptions) {
  return {
    version: `markdown-3;${COMPILER_VERSION}`,
    key: (context: FieldContext) =>
      optionsCacheKey(resolveOptions(context, field), context),
  };
}

/**
 * HTML compiled from the document body. Raw HTML is sanitized unless
 * `allowDangerousHtml` is set; relative images and files are copied when an
 * assets plugin is registered. Needs `markdown()` in `plugins`.
 */
export function body(options: MarkdownOptions = {}): z.ZodString {
  return defineField(z.string(), {
    kind: "markdown",
    requires: MARKDOWN_PLUGIN,
    whenAbsent: "compile",
    cache: cacheOf(options),
    compile: (input: FieldInput, context: FieldContext) => {
      if (input !== undefined && input !== null) {
        throw new Error(
          "md.body() is compiled from the document body; remove this key from the file, or use md.markdown() for a Markdown field.",
        );
      }
      return compileMarkdown(
        context.body ?? "",
        resolveOptions(context, options),
        context,
      );
    },
  });
}

/**
 * HTML compiled from a Markdown string field (for example `summary`). A
 * missing key stays missing, so `.optional()` works as usual.
 */
export function markdownField(options: MarkdownOptions = {}): z.ZodString {
  return defineField(z.string(), {
    kind: "markdown",
    requires: MARKDOWN_PLUGIN,
    whenAbsent: "skip",
    cache: cacheOf(options),
    compile: (input: FieldInput, context: FieldContext) => {
      if (!isString(input)) {
        throw new Error("md.markdown() needs a string.");
      }
      return compileMarkdown(input, resolveOptions(context, options), context);
    },
  });
}

/**
 * Markdown field helpers. Import as `import { schema as md } from "@anhur/markdown"`.
 *
 * - `md.body()` — the document body as HTML
 * - `md.markdown()` — a Markdown string field as HTML
 */
export const schema = {
  body,
  markdown: markdownField,
};
