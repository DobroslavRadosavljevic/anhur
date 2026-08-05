import {
  defineProcessor,
  getBuildContext,
  getDocumentMeta,
  type ProcessorPlugin,
} from "@anhur/core";
import { z } from "zod";
import { withBodyAssetRemarkPlugins } from "./body-assets";
import { compileMdx, type CompileMdxOptions } from "./compile";

export const MDX_PROCESSOR_ID = "mdx";

export type MdxProcessorOptions = {
  gfm?: boolean;
  remarkPlugins?: CompileMdxOptions["remarkPlugins"];
  rehypePlugins?: CompileMdxOptions["rehypePlugins"];
} & Omit<
  CompileMdxOptions,
  "gfm" | "remarkPlugins" | "rehypePlugins" | "outputFormat"
>;

/**
 * Register MDX processor defaults on `defineConfig({ processors })`.
 */
export function mdx(
  options: MdxProcessorOptions = {},
): ProcessorPlugin<MdxProcessorOptions> {
  return defineProcessor(MDX_PROCESSOR_ID, options);
}

export type MdxFieldOptions = MdxProcessorOptions;

/**
 * Field helper: compile body (or string field) to an MDX function-body.
 * Requires `mdx(...)` in `defineConfig({ processors })`.
 * Relative body assets are copied when `assets()` is registered.
 */
function mdxField(fieldOptions: MdxFieldOptions = {}) {
  return z
    .string()
    .optional()
    .transform(async (value) => {
      const meta = getDocumentMeta();
      const build = getBuildContext();
      const plugin = build.getProcessor(MDX_PROCESSOR_ID);
      if (!plugin) {
        throw new Error(
          `m.mdx() requires an MDX processor. Add mdx() from @anhur/mdx to defineConfig({ processors }). (file: ${meta.path})`,
        );
      }

      const registered = plugin.options as MdxProcessorOptions;
      const source = value ?? meta.content ?? "";
      if (source.length === 0) {
        throw new Error(`MDX content is empty (${meta.path})`);
      }

      const gfm = fieldOptions.gfm ?? registered.gfm ?? true;
      const remarkPlugins = await withBodyAssetRemarkPlugins([
        ...((fieldOptions.remarkPlugins as NonNullable<
          CompileMdxOptions["remarkPlugins"]
        >) ?? []),
        ...((registered.remarkPlugins as NonNullable<
          CompileMdxOptions["remarkPlugins"]
        >) ?? []),
      ]);
      const rehypePlugins = [
        ...((fieldOptions.rehypePlugins as NonNullable<
          CompileMdxOptions["rehypePlugins"]
        >) ?? []),
        ...((registered.rehypePlugins as NonNullable<
          CompileMdxOptions["rehypePlugins"]
        >) ?? []),
      ];

      const { gfm: _regGfm, ...regRest } = registered;
      const { gfm: _fieldGfm, ...fieldRest } = fieldOptions;

      const compile = () =>
        compileMdx(
          { content: source, filePath: meta.path },
          {
            ...regRest,
            ...fieldRest,
            gfm,
            remarkPlugins,
            rehypePlugins,
          },
        );

      const persist = build.persistCache;
      // Skip disk cache when assets rewrite body URLs — linked files must be
      // re-emitted every build (content-hashed copy).
      if (!persist || build.assets) return compile();

      return persist.getOrCompute(
        `mdx:${meta.path}`,
        {
          source,
          gfm,
          remarkPluginCount: remarkPlugins.length,
          rehypePluginCount: rehypePlugins.length,
        },
        compile,
      );
    });
}

/**
 * MDX schema helpers. Import as `import { schema as m } from "@anhur/mdx"`.
 */
export const schema = {
  mdx: mdxField,
};
