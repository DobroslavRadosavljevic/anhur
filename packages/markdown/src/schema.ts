import {
  defineProcessor,
  fingerprintCacheValue,
  getBuildContext,
  getDocumentMeta,
  type ProcessorPlugin,
} from "@anhur/core";
import { z } from "zod";
import { withBodyAssetRemarkPlugins } from "./body-assets";
import { compileMarkdown, type CompileMarkdownOptions } from "./compile";

export const MARKDOWN_PROCESSOR_ID = "markdown";

export type MarkdownProcessorOptions = {
  gfm?: boolean;
  remarkPlugins?: CompileMarkdownOptions["remarkPlugins"];
  rehypePlugins?: CompileMarkdownOptions["rehypePlugins"];
};

/**
 * Register Markdown→HTML processor defaults on `defineConfig({ processors })`.
 */
export function markdown(
  options: MarkdownProcessorOptions = {},
): ProcessorPlugin<MarkdownProcessorOptions> {
  return defineProcessor(MARKDOWN_PROCESSOR_ID, options);
}

export type MarkdownFieldOptions = MarkdownProcessorOptions;

function isMarkdownProcessorOptions<T>(
  options: T,
): options is T & MarkdownProcessorOptions {
  return typeof options === "object" && options !== null;
}

function readMarkdownProcessorOptions<T>(options: T): MarkdownProcessorOptions {
  if (!isMarkdownProcessorOptions(options)) return {};
  return options;
}

/**
 * Field helper: compile body (or string field) to HTML.
 * Requires `markdown(...)` in `defineConfig({ processors })`.
 * Relative body assets are copied when `assets()` is registered.
 */
function markdownField(fieldOptions: MarkdownFieldOptions = {}) {
  return z
    .string()
    .optional()
    .transform(async (value) => {
      const meta = getDocumentMeta();
      const build = getBuildContext();
      const plugin = build.getProcessor(MARKDOWN_PROCESSOR_ID);
      if (!plugin) {
        throw new Error(
          `md.markdown() requires a Markdown processor. Add markdown() from @anhur/markdown to defineConfig({ processors }). (file: ${meta.path})`,
        );
      }

      const registered = readMarkdownProcessorOptions(plugin.options);
      const source = value ?? meta.content ?? "";
      if (source.length === 0) {
        throw new Error(`Markdown content is empty (${meta.path})`);
      }

      const gfm = fieldOptions.gfm ?? registered.gfm ?? true;
      const remarkPlugins = await withBodyAssetRemarkPlugins([
        ...(fieldOptions.remarkPlugins ?? []),
        ...(registered.remarkPlugins ?? []),
      ]);
      const rehypePlugins = [
        ...(fieldOptions.rehypePlugins ?? []),
        ...(registered.rehypePlugins ?? []),
      ];

      const compile = () =>
        compileMarkdown(source, {
          gfm,
          remarkPlugins,
          rehypePlugins,
          filePath: meta.path,
        });

      const persist = build.persistCache;
      // Skip disk cache when assets rewrite body URLs — linked files must be
      // re-emitted every build (content-hashed copy).
      if (!persist || build.assets) return compile();

      return persist.getOrCompute(
        `markdown:${meta.path}`,
        fingerprintCacheValue({
          source,
          gfm,
          remarkPlugins,
          rehypePlugins,
        }),
        compile,
      );
    });
}

/**
 * Markdown schema helpers. Import as `import { schema as md } from "@anhur/markdown"`.
 */
export const schema = {
  markdown: markdownField,
};
