import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mdxFromMarkdown } from "mdast-util-mdx";
import { gfm } from "micromark-extension-gfm";
import { mdxjs } from "micromark-extension-mdxjs";
import { installedVersion } from "../plugin/versions";

/**
 * Versions of the built-in body parser (and `@anhur/core` itself), part of
 * the cache key of body-derived fields.
 */
export const BODY_PARSER_VERSION = [
  "@anhur/core",
  "github-slugger",
  "hast-util-to-string",
  "mdast-util-from-markdown",
  "mdast-util-gfm",
  "mdast-util-mdx",
  "micromark-extension-gfm",
  "micromark-extension-mdxjs",
]
  .map((name) => `${name}@${installedVersion(name, import.meta.url)}`)
  .join(",");

export type BodySyntax = {
  /** Parse MDX syntax (ESM, JSX, `{expressions}`), as for `.mdx` files. */
  readonly mdx?: boolean;
};

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Inline code span, HTML / JSX tag, or `{expression}` on one line. Code
 * spans come first in the alternation so their contents are kept.
 */
const INLINE_MDX = /(`+)[\s\S]*?\1|<\/?[A-Za-z][^<>]*>|\{[^{}]*\}/g;

function stripInlineMdx(line: string): string {
  let text = line;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = text.replace(INLINE_MDX, (match) =>
      match.startsWith("`") ? match : " ",
    );
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * Last-resort cleanup for MDX that does not parse: drop ESM blocks (an
 * `import` / `export` line up to the next blank line) and single-line JSX
 * tags / `{expressions}`, but never inside fenced code blocks or inline
 * code. Leaves anything it is unsure about, so headings and text are never
 * swallowed.
 */
export function stripInvalidMdx(source: string): string {
  const kept: string[] = [];
  let fence: { readonly marker: string; readonly size: number } | undefined;
  let inEsm = false;
  for (const line of source.split(/\r?\n/)) {
    if (fence) {
      kept.push(line);
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (
        close?.[1] !== undefined &&
        close[1][0] === fence.marker &&
        close[1].length >= fence.size
      ) {
        fence = undefined;
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open?.[1] !== undefined) {
      inEsm = false;
      fence = { marker: open[1][0] ?? "`", size: open[1].length };
      kept.push(line);
      continue;
    }
    if (inEsm) {
      if (line.trim().length === 0) inEsm = false;
      continue;
    }
    if (/^(?:import|export)\b/.test(line)) {
      inEsm = true;
      continue;
    }
    kept.push(stripInlineMdx(line));
  }
  return kept.join("\n");
}

function parseMarkdown(source: string): Root {
  return fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

/**
 * Parse a body into mdast with GFM (tables, strikethrough, footnotes), plus
 * MDX syntax when `mdx` is set. MDX that does not parse is read as Markdown
 * after {@link stripInvalidMdx}; compiling it still fails in `@anhur/mdx`.
 */
export function parseBody(source: string, syntax: BodySyntax = {}): Root {
  if (!syntax.mdx) return parseMarkdown(source);
  try {
    return fromMarkdown(source, {
      extensions: [mdxjs(), gfm()],
      mdastExtensions: [mdxFromMarkdown(), gfmFromMarkdown()],
    });
  } catch {
    return parseMarkdown(stripInvalidMdx(source));
  }
}

const BLOCKS = new Set<string>([
  "paragraph",
  "heading",
  "listItem",
  "tableCell",
  "tableRow",
  "blockquote",
  "footnoteDefinition",
  "mdxJsxFlowElement",
]);

function collectText(node: Nodes, out: string[]): void {
  switch (node.type) {
    case "text":
    case "inlineCode":
      out.push(node.value);
      return;
    case "code":
    case "html":
    case "image":
    case "imageReference":
    case "definition":
    case "break":
    case "mdxjsEsm":
    case "mdxFlowExpression":
    case "mdxTextExpression":
      out.push(" ");
      return;
    default:
      if ("children" in node) {
        for (const child of node.children) collectText(child, out);
        if (BLOCKS.has(node.type)) out.push(" ");
      }
  }
}

/**
 * Visible text of a Markdown / MDX body, whitespace collapsed. Code blocks,
 * raw HTML, images, MDX ESM and `{expressions}` are left out; text inside
 * JSX elements is kept.
 */
export function toPlainText(source: string, syntax: BodySyntax = {}): string {
  if (source.trim().length === 0) return "";
  const out: string[] = [];
  collectText(parseBody(source, syntax), out);
  return out.join("").replace(/\s+/g, " ").trim();
}

function segmenter(
  locale: string | undefined,
  granularity: "word" | "grapheme",
): Intl.Segmenter {
  try {
    return new Intl.Segmenter(locale, { granularity });
  } catch {
    return new Intl.Segmenter("en", { granularity });
  }
}

/** Number of words, using the locale's word segmentation (works for CJK, Cyrillic, …). */
export function countWords(text: string, locale?: string): number {
  let count = 0;
  for (const segment of segmenter(locale, "word").segment(text)) {
    if (segment.isWordLike) count += 1;
  }
  return count;
}

/**
 * Cut text to at most `length` user-perceived characters (graphemes),
 * including the trailing `…`. Never splits an emoji or combined character.
 */
export function truncateText(text: string, length: number): string {
  const graphemes = [...segmenter(undefined, "grapheme").segment(text)].map(
    (segment) => segment.segment,
  );
  if (graphemes.length <= length) return text;
  if (length <= 1) return "…".slice(0, length);
  const head = graphemes
    .slice(0, length - 1)
    .join("")
    .trimEnd();
  return `${head}…`;
}
