import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  collectHastHeadings,
  installedVersion,
  rehypeLinkedAssets,
  type BodyHeading,
  type FieldContext,
} from "@anhur/core/plugin";
import type { Properties, Root } from "hast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified, type PluggableList } from "unified";
import { visit } from "unist-util-visit";
import type { MarkdownOptions, SanitizeSchema } from "./plugin";

const require = createRequire(import.meta.url);

/** Installed version of `name`, as seen from this package or from `via`. */
function versionOf(name: string, via?: string): string {
  if (via === undefined) return installedVersion(name, import.meta.url);
  try {
    return installedVersion(name, pathToFileURL(require.resolve(via)).href);
  } catch {
    return "unknown";
  }
}

/**
 * Versions of everything that shapes the HTML (this package, `@anhur/core`
 * for link rewriting, the unified plugins and the utilities they wrap),
 * part of the field cache key.
 */
export const COMPILER_VERSION = [
  ["@anhur/markdown"],
  ["@anhur/core"],
  ["unified"],
  ["remark-parse"],
  ["mdast-util-from-markdown", "remark-parse"],
  ["remark-gfm"],
  ["mdast-util-gfm", "remark-gfm"],
  ["micromark-extension-gfm", "remark-gfm"],
  ["remark-rehype"],
  ["mdast-util-to-hast", "remark-rehype"],
  ["rehype-raw"],
  ["hast-util-raw", "rehype-raw"],
  ["rehype-sanitize"],
  ["hast-util-sanitize", "rehype-sanitize"],
  ["rehype-slug"],
  ["github-slugger", "rehype-slug"],
  ["hast-util-to-string", "rehype-slug"],
  ["rehype-stringify"],
  ["hast-util-to-html", "rehype-stringify"],
]
  .map(([name = "", via]) => `${name}@${versionOf(name, via)}`)
  .join(",");

const HTTP = ["http", "https"];

/**
 * Default sanitize schema: GitHub's (`rehype-sanitize` `defaultSchema`)
 * plus media: `<video>` (`src`, `poster`, `controls`, `loop`, `muted`,
 * `playsInline`, `preload`, `width`, `height`; no `autoPlay`), `<audio>`,
 * `<source>` (`src`, `srcSet`, `type`, `media`, `sizes`), `<track>` and
 * `<picture>`, and `<img>` `srcSet` / `sizes` / `loading` / `decoding`.
 * `src`, `poster` and `srcSet` URLs must be relative or `http(s)`.
 */
export const DEFAULT_SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "video",
    "audio",
    "source",
    "track",
    "picture",
  ],
  attributes: {
    ...defaultSchema.attributes,
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "srcSet",
      "sizes",
      ["loading", "lazy", "eager"],
      ["decoding", "sync", "async", "auto"],
    ],
    video: [
      "src",
      "poster",
      "controls",
      "loop",
      "muted",
      "playsInline",
      ["preload", "none", "metadata", "auto"],
    ],
    audio: [
      "src",
      "controls",
      "loop",
      "muted",
      ["preload", "none", "metadata", "auto"],
    ],
    source: [
      ...(defaultSchema.attributes?.source ?? []),
      "src",
      "type",
      "sizes",
    ],
    track: [
      "src",
      ["kind", "subtitles", "captions", "descriptions", "chapters", "metadata"],
      "srcLang",
      "default",
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: HTTP,
    poster: HTTP,
    srcSet: HTTP,
  },
};

function stringProperty(value: Properties[string]): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Sanitizing prefixes `id` / `name` values (`user-content-`), but not the
 * `#x` links pointing at them. Point such links at the prefixed id when
 * `x` itself does not exist (GFM footnotes, raw `<a id>` anchors).
 */
function rehypePrefixedAnchors(prefix: string) {
  return () =>
    (tree: Root): void => {
      if (prefix.length === 0) return;
      const ids = new Set<string>();
      visit(tree, "element", (node) => {
        for (const key of ["id", "name"]) {
          const value = stringProperty(node.properties[key]);
          if (value !== undefined) ids.add(value);
        }
      });
      visit(tree, "element", (node) => {
        const href = stringProperty(node.properties.href);
        if (node.tagName !== "a" || !href?.startsWith("#")) return;
        const raw = href.slice(1);
        let id = raw;
        try {
          id = decodeURIComponent(raw);
        } catch {
          id = raw;
        }
        if (!ids.has(id) && ids.has(`${prefix}${id}`)) {
          node.properties.href = `#${prefix}${raw}`;
        }
      });
    };
}

function rehypeCollectHeadings(headings: BodyHeading[]) {
  return () =>
    (tree: Root): void => {
      headings.push(...collectHastHeadings(tree));
    };
}

type Stage =
  /** Full compile to HTML; relative URLs are resolved with a `context`. */
  | { readonly kind: "html"; readonly context: FieldContext | undefined }
  /** Up to heading ids only (no assets, no user rehype plugins). */
  | { readonly kind: "headings"; readonly headings: BodyHeading[] };

/**
 * Markdown → HTML:
 *
 * 1. parse (+ GFM), then your remark plugins
 * 2. to HTML; raw HTML is parsed into elements (`rehype-raw`)
 * 3. sanitized (unless `allowDangerousHtml`); `#x` links follow prefixed ids
 * 4. relative files copied as assets and links rewritten (with a `context`)
 * 5. heading ids added (`headingIds`, default on)
 * 6. your rehype plugins, then serialized
 *
 * Heading extraction for `s.toc()` runs steps 1–3 and 5 only.
 */
function createProcessor(options: MarkdownOptions, stage: Stage) {
  const sanitize = options.allowDangerousHtml !== true;
  const schema = options.sanitizeSchema ?? DEFAULT_SANITIZE_SCHEMA;
  const rehypePlugins: PluggableList = [rehypeRaw];
  if (sanitize) {
    rehypePlugins.push(
      [rehypeSanitize, schema],
      rehypePrefixedAnchors(schema.clobberPrefix ?? ""),
    );
  }
  if (stage.kind === "html" && stage.context) {
    rehypePlugins.push([
      rehypeLinkedAssets,
      { context: stage.context, documentLink: options.documentLink },
    ]);
  }
  if (options.headingIds !== false) rehypePlugins.push(rehypeSlug);
  if (stage.kind === "headings") {
    rehypePlugins.push(rehypeCollectHeadings(stage.headings));
  } else {
    rehypePlugins.push(...(options.rehypePlugins ?? []));
  }
  return (
    unified()
      .use(remarkParse)
      .use(options.gfm === false ? [] : [remarkGfm])
      .use(options.remarkPlugins ?? [])
      // Sanitizing adds the `user-content-` prefix to footnote ids itself.
      .use(remarkRehype, {
        allowDangerousHtml: true,
        ...(sanitize ? { clobberPrefix: "" } : {}),
      })
      .use(rehypePlugins)
  );
}

type SourceFile = { readonly value: string; readonly path?: string };

function sourceFile(
  source: string,
  context: FieldContext | undefined,
): SourceFile {
  return context
    ? { value: source, path: context.document.filePath }
    : { value: source };
}

/**
 * Compile Markdown to HTML. With a field `context`, relative files are
 * copied as assets and links rewritten; without one, URLs stay as written.
 */
export async function compileMarkdown(
  source: string,
  options: MarkdownOptions = {},
  context?: FieldContext,
): Promise<string> {
  const file = await createProcessor(options, { kind: "html", context })
    .use(rehypeStringify)
    .process(sourceFile(source, context));
  return String(file);
}

/**
 * Headings of the compiled HTML with their ids, in document order. Runs the
 * same pipeline as {@link compileMarkdown} up to heading ids, without
 * resolving assets.
 */
export async function extractMarkdownHeadings(
  source: string,
  options: MarkdownOptions = {},
  context?: FieldContext,
): Promise<BodyHeading[]> {
  const headings: BodyHeading[] = [];
  const processor = createProcessor(options, { kind: "headings", headings });
  const file = sourceFile(source, context);
  await processor.run(processor.parse(file), file);
  return headings;
}
