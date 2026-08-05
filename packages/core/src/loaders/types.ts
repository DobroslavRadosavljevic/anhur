export type LoadedFile = {
  /** Structured fields (frontmatter or whole YAML/JSON document). */
  data: Record<string, unknown>;
  /** Markdown/MDX body without frontmatter. */
  content?: string;
};

export type Loader = {
  /** Match absolute or relative file paths (usually by extension). */
  test: RegExp;
  load: (file: {
    path: string;
    raw: string;
  }) => LoadedFile | Promise<LoadedFile>;
};

export function defineLoader<T extends Loader>(loader: T): T {
  return loader;
}
