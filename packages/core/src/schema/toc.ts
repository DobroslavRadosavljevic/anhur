import { Predicate } from "effect";
import GithubSlugger from "github-slugger";
import type { Root as HastRoot } from "hast";
import { toString as hastText } from "hast-util-to-string";
import type { Heading, Nodes } from "mdast";
import { SKIP, visit } from "unist-util-visit";
import type { BodyHeading } from "../plugin/types";
import { parseBody, type BodySyntax } from "./text";

export type TocEntry = {
  title: string;
  /** `#id` of the heading in the compiled body. */
  url: string;
  items: TocEntry[];
};

export type TocOptions = {
  /** Deepest heading level to include (default 6). */
  readonly maxDepth?: 1 | 2 | 3 | 4 | 5 | 6;
};

/**
 * Heading text the way `rehype-slug` sees it (`hast-util-to-string` of the
 * compiled heading): text, inline code and JSX children count; raw HTML,
 * image alt text and MDX `{expressions}` do not.
 */
function headingText(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value;
    case "break":
      return "\n";
    case "html":
    case "image":
    case "imageReference":
    case "footnoteReference":
    case "mdxTextExpression":
    case "mdxFlowExpression":
    case "mdxjsEsm":
      return "";
    default:
      return "children" in node
        ? node.children.map((child) => headingText(child)).join("")
        : "";
  }
}

/**
 * Headings of a body read with the built-in parser (GFM, plus MDX syntax
 * for `.mdx`), with `github-slugger` ids like `rehype-slug` gives them.
 * `s.toc()` uses this only when no `markdown()` / `mdx()` plugin reports the
 * headings of its own output.
 */
export function extractHeadings(
  source: string,
  syntax: BodySyntax = {},
): BodyHeading[] {
  if (source.trim().length === 0) return [];
  const slugger = new GithubSlugger();
  const headings: BodyHeading[] = [];
  visit(parseBody(source, syntax), "heading", (node: Heading) => {
    const text = headingText(node);
    headings.push({ depth: node.depth, id: slugger.slug(text), text });
    return SKIP;
  });
  return headings;
}

function headingDepth(tagName: string): BodyHeading["depth"] | undefined {
  switch (tagName) {
    case "h1":
      return 1;
    case "h2":
      return 2;
    case "h3":
      return 3;
    case "h4":
      return 4;
    case "h5":
      return 5;
    case "h6":
      return 6;
    default:
      return undefined;
  }
}

/**
 * Headings (`h1`–`h6` with an `id`) of compiled HTML, for `headings`
 * extractors of body compiler plugins: run your pipeline up to heading
 * ids, then call this on the tree. `text` is `hast-util-to-string` of the
 * heading (what `rehype-slug` slugs). The GFM footnotes section heading is
 * left out.
 */
export function collectHastHeadings(tree: HastRoot): BodyHeading[] {
  const headings: BodyHeading[] = [];
  visit(tree, "element", (node) => {
    const footnotes = node.properties.dataFootnotes;
    if (
      node.tagName === "section" &&
      footnotes !== undefined &&
      footnotes !== null &&
      footnotes !== false
    ) {
      return SKIP;
    }
    const depth = headingDepth(node.tagName);
    if (depth === undefined) return undefined;
    const id = node.properties.id;
    if (Predicate.isString(id) && id.length > 0) {
      headings.push({ depth, id, text: hastText(node) });
    }
    return SKIP;
  });
  return headings;
}

/**
 * Nest headings into a table of contents. A skipped level (`#` then `###`)
 * nests under the nearest shallower heading; headings deeper than
 * `maxDepth` and headings without text are left out.
 */
export function tocFromHeadings(
  headings: readonly BodyHeading[],
  options: TocOptions = {},
): TocEntry[] {
  const maxDepth = options.maxDepth ?? 6;
  const root: TocEntry[] = [];
  const stack: { readonly depth: number; readonly entry: TocEntry }[] = [];
  for (const heading of headings) {
    if (heading.depth > maxDepth) continue;
    const title = heading.text.replace(/\s+/g, " ").trim();
    if (title.length === 0) continue;
    const entry: TocEntry = { title, url: `#${heading.id}`, items: [] };
    while ((stack.at(-1)?.depth ?? 0) >= heading.depth) stack.pop();
    (stack.at(-1)?.entry.items ?? root).push(entry);
    stack.push({ depth: heading.depth, entry });
  }
  return root;
}

/** Table of contents of a Markdown / MDX body with the built-in parser. Empty bodies give `[]`. */
export function buildToc(
  source: string,
  options: TocOptions & BodySyntax = {},
): TocEntry[] {
  return tocFromHeadings(extractHeadings(source, options), options);
}
