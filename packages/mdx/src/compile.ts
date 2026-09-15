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
function isMdxDocumentInput(
  source: string | MdxDocumentInput,
): source is MdxDocumentInput {
  return typeof source !== "string";
}

export async function compileMdx(
  source: string | MdxDocumentInput,
  options: CompileMdxOptions = {},
): Promise<string> {
  const { gfm = true, remarkPlugins, ...rest } = options;

  const value = isMdxDocumentInput(source) ? source.content : source;
  const path = isMdxDocumentInput(source) ? source.filePath : undefined;

  const extraPlugins = remarkPlugins ?? [];
  const plugins: CompileOptions["remarkPlugins"] = [
    ...(gfm ? [remarkGfm] : []),
    ...extraPlugins,
  ];

  const file = await compile(path ? { value, path } : value, {
    ...rest,
    outputFormat: "function-body",
    remarkPlugins: plugins,
  });

  return String(file);
}
