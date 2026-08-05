import { compile, type CompileOptions } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";

export type CompileMdxOptions = Omit<CompileOptions, "outputFormat"> & {
  /**
   * Enable GitHub Flavored Markdown (tables, strikethrough, …).
   * Default: `true`.
   */
  gfm?: boolean;
};

export type MdxDocumentInput = {
  /** Markdown / MDX body (no frontmatter). */
  content: string;
  /** Optional absolute path — improves MDX error messages. */
  filePath?: string;
};

/**
 * Compile MDX/Markdown source to a JavaScript **function-body** string.
 *
 * Prefer `m.mdx()` in collection schemas. This function is the low-level API.
 */
export async function compileMdx(
  source: string | MdxDocumentInput,
  options: CompileMdxOptions = {},
): Promise<string> {
  const { gfm = true, remarkPlugins, ...rest } = options;

  const value = typeof source === "string" ? source : source.content;
  const path = typeof source === "string" ? undefined : source.filePath;

  const plugins = [
    ...(gfm ? [remarkGfm] : []),
    ...((remarkPlugins as NonNullable<CompileOptions["remarkPlugins"]>) ?? []),
  ] as CompileOptions["remarkPlugins"];

  const file = await compile(path ? { value, path } : value, {
    ...rest,
    outputFormat: "function-body",
    remarkPlugins: plugins,
  });

  return String(file);
}
