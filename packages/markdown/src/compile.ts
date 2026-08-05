import rehypeRaw from "rehype-raw";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified, type PluggableList } from "unified";

export type CompileMarkdownOptions = {
  gfm?: boolean;
  remarkPlugins?: PluggableList;
  rehypePlugins?: PluggableList;
  /** Absolute path — improves error messages. */
  filePath?: string;
};

/**
 * Compile Markdown source to an HTML string.
 */
export async function compileMarkdown(
  source: string,
  options: CompileMarkdownOptions = {},
): Promise<string> {
  const {
    gfm = true,
    remarkPlugins = [],
    rehypePlugins = [],
    filePath,
  } = options;

  const remarks: PluggableList = [
    ...(gfm ? [remarkGfm] : []),
    ...remarkPlugins,
  ];
  const rehyps: PluggableList = [...rehypePlugins];

  const file = await unified()
    .use(remarkParse)
    .use(remarks)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehyps)
    .use(rehypeStringify)
    .process(filePath ? { value: source, path: filePath } : { value: source });

  return String(file);
}
