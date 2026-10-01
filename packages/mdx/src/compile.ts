import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectHastHeadings,
  installedVersion,
  rehypeLinkedAssets,
  type BodyHeading,
  type FieldContext,
} from "@anhur/core/plugin";
import { compile, nodeTypes } from "@mdx-js/mdx";
import type { Root as HastRoot } from "hast";
import type { Root } from "mdast";
import rehypeRaw from "rehype-raw";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { visit } from "unist-util-visit";
import type { MdxOptions } from "./plugin";

/** Installed version of `name`, as seen from this package or through `via` (outermost first). */
function versionOf(name: string, ...via: readonly string[]): string {
  let fromUrl = import.meta.url;
  try {
    for (const parent of via) {
      fromUrl = pathToFileURL(createRequire(fromUrl).resolve(parent)).href;
    }
  } catch {
    return "unknown";
  }
  return installedVersion(name, fromUrl);
}

/**
 * Versions of everything that shapes the compiled code (this package,
 * `@anhur/core` for link rewriting, MDX and the plugins around it), part of
 * the field cache key.
 */
export const COMPILER_VERSION = [
  ["@anhur/mdx"],
  ["@anhur/core"],
  ["@mdx-js/mdx"],
  ["remark-parse", "@mdx-js/mdx"],
  ["remark-mdx", "@mdx-js/mdx"],
  ["remark-rehype", "@mdx-js/mdx"],
  ["mdast-util-to-hast", "@mdx-js/mdx", "remark-rehype"],
  ["rehype-recma", "@mdx-js/mdx"],
  ["recma-build-jsx", "@mdx-js/mdx"],
  ["recma-jsx", "@mdx-js/mdx"],
  ["recma-stringify", "@mdx-js/mdx"],
  ["remark-gfm"],
  ["mdast-util-gfm", "remark-gfm"],
  ["micromark-extension-gfm", "remark-gfm"],
  ["rehype-raw"],
  ["hast-util-raw", "rehype-raw"],
  ["rehype-slug"],
  ["github-slugger", "rehype-slug"],
  ["hast-util-to-string", "rehype-slug"],
]
  .map(([name = "", ...via]) => `${name}@${versionOf(name, ...via)}`)
  .join(",");

/** Extensions `@mdx-js/mdx` compiles as plain Markdown (`markdown-extensions`). */
const MARKDOWN_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdown",
  ".mkdn",
  ".mkd",
  ".mdwn",
  ".mkdown",
  ".ron",
]);

/** Minimal ESTree view (MDX nodes carry `data.estree`). */
type EstreeValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | RegExp
  | EstreeNode
  | readonly EstreeValue[];

type EstreeNode = {
  readonly type: string;
  readonly [key: string]: EstreeValue;
};

function isEstreeNode<T>(value: T): value is T & EstreeNode {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "type" in value &&
    typeof value.type === "string"
  );
}

type WithEstree = {
  readonly data?: { readonly estree?: EstreeValue };
};

type AttributeExpression = WithEstree & { readonly type: string };

/** MDX mdast nodes (structural: not part of the core mdast types here). */
type MdxNode = WithEstree & {
  readonly type: string;
  readonly position?: { readonly start: { readonly line: number } };
  readonly attributes?: readonly (WithEstree & {
    readonly type: string;
    readonly value?: string | null | AttributeExpression;
  })[];
};

const MDX_NODE_TYPES = new Set<string>(nodeTypes);

function isMdxNode<T extends { readonly type: string }>(
  node: T,
): node is T & MdxNode {
  return MDX_NODE_TYPES.has(node.type);
}

function isAttributeExpression(
  value: string | null | undefined | AttributeExpression,
): value is AttributeExpression {
  return value !== null && value !== undefined && typeof value === "object";
}

const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

type SourceLocation = { readonly start: { readonly line: number } };

function isSourceLocation(value: unknown): value is SourceLocation {
  return (
    value !== null &&
    typeof value === "object" &&
    "start" in value &&
    value.start !== null &&
    typeof value.start === "object" &&
    "line" in value.start &&
    typeof value.start.line === "number"
  );
}

/** Line of an ESTree node (MDX maps `loc` to the document). */
function estreeLine(node: EstreeNode): number | undefined {
  const loc: unknown = node.loc;
  return isSourceLocation(loc) ? loc.start.line : undefined;
}

type Forbidden = { readonly message: string; readonly line?: number };

/**
 * First construct the function-body output cannot run: `import(…)`
 * anywhere, `import` / `export … from` declarations, and `await` outside a
 * function.
 */
function findForbidden(
  value: EstreeValue,
  inFunction: boolean,
  depth: number,
): Forbidden | undefined {
  if (depth > 512) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbidden(item, inFunction, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isEstreeNode(value)) return undefined;
  const line = estreeLine(value);
  switch (value.type) {
    case "ImportExpression":
      return { message: "dynamic import() is not supported", line };
    case "ImportDeclaration":
      return { message: "imports are not supported", line };
    case "ExportNamedDeclaration":
    case "ExportAllDeclaration":
      if (value.source !== null && value.source !== undefined) {
        return {
          message: "re-exports (export … from) are not supported",
          line,
        };
      }
      break;
    case "AwaitExpression":
      if (!inFunction) {
        return { message: "top-level await is not supported", line };
      }
      break;
    case "ForOfStatement":
      if (!inFunction && value.await === true) {
        return { message: "top-level for await is not supported", line };
      }
      break;
    default:
      break;
  }
  const nested = inFunction || FUNCTIONS.has(value.type);
  for (const [key, child] of Object.entries(value)) {
    if (key === "type" || key === "loc" || key === "range") continue;
    const found = findForbidden(child, nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Every `data.estree` program of an MDX node, including JSX attributes. */
function estreePrograms(node: MdxNode): EstreeValue[] {
  const programs: EstreeValue[] = [];
  if (node.data?.estree) programs.push(node.data.estree);
  for (const attribute of node.attributes ?? []) {
    if (attribute.data?.estree) programs.push(attribute.data.estree);
    const value = attribute.value;
    if (isAttributeExpression(value) && value.data?.estree) {
      programs.push(value.data.estree);
    }
  }
  return programs;
}

/**
 * Reject code a function-body module cannot run, at build time instead of
 * render time: `import` / `export … from`, dynamic `import()` (in ESM,
 * `{expressions}` and JSX attributes) and top-level `await`. Local
 * `export const x = …` is fine.
 */
function remarkRejectModuleCode() {
  return (tree: Root): void => {
    visit(tree, (node) => {
      // MDX nodes are not part of the mdast types here; inspect them structurally.
      const loose: { readonly type: string } = node;
      if (!isMdxNode(loose)) return;
      for (const program of estreePrograms(loose)) {
        const found = findForbidden(program, false, 0);
        if (!found) continue;
        const line = found.line ?? loose.position?.start.line;
        throw new Error(
          `MDX ${found.message}${line ? ` (line ${line})` : ""}: compiled MDX is a function body evaluated without a module loader. Pass components to <MdxContent components={…} /> instead.`,
        );
      }
    });
  };
}

function rehypeCollectHeadings(headings: BodyHeading[]) {
  return () =>
    (tree: HastRoot): HastRoot => {
      headings.push(...collectHastHeadings(tree));
      // Nothing after the heading ids matters: skip compiling the rest.
      return { type: "root", children: [] };
    };
}

/** Where the source comes from; decides the MDX `format` when not set. */
export type MdxSourceKind = "body" | "field";

type Stage =
  /** Full compile; relative URLs are resolved when there is a context. */
  | { readonly kind: "code" }
  /** Up to heading ids only (no assets, no user rehype / recma plugins). */
  | { readonly kind: "headings"; readonly headings: BodyHeading[] };

/**
 * `md` or `mdx`: the `format` option when set; otherwise a document body is
 * Markdown when its file has a Markdown extension (as `@mdx-js/mdx` detects
 * it), and an `m.mdx()` string field is always MDX.
 */
function resolveFormat(
  options: MdxOptions,
  sourceKind: MdxSourceKind,
  context: FieldContext | undefined,
): "md" | "mdx" {
  if (options.format === "md" || options.format === "mdx") {
    return options.format;
  }
  if (sourceKind === "field" || !context) return "mdx";
  const extension = path.extname(context.document.filePath).toLowerCase();
  return MARKDOWN_EXTENSIONS.has(extension) ? "md" : "mdx";
}

async function run(
  source: string,
  options: MdxOptions,
  sourceKind: MdxSourceKind,
  context: FieldContext | undefined,
  stage: Stage,
): Promise<string> {
  const format = resolveFormat(options, sourceKind, context);
  const rehypePlugins: PluggableList = [];
  // Markdown format: keep raw HTML as elements (MDX alone would drop it).
  if (format === "md") {
    rehypePlugins.push([rehypeRaw, { passThrough: [...nodeTypes] }]);
  }
  if (context && stage.kind === "code") {
    rehypePlugins.push([
      rehypeLinkedAssets,
      { context, documentLink: options.documentLink },
    ]);
  }
  if (options.headingIds !== false) rehypePlugins.push(rehypeSlug);
  if (stage.kind === "headings") {
    rehypePlugins.push(rehypeCollectHeadings(stage.headings));
  } else {
    rehypePlugins.push(...(options.rehypePlugins ?? []));
  }
  const file = await compile(
    context
      ? { value: source, path: context.document.filePath }
      : { value: source },
    {
      format,
      recmaPlugins: stage.kind === "code" ? options.recmaPlugins : [],
      remarkRehypeOptions: options.remarkRehypeOptions,
      elementAttributeNameCase: options.elementAttributeNameCase,
      stylePropertyNameCase: options.stylePropertyNameCase,
      outputFormat: "function-body",
      development: false,
      remarkPlugins: [
        ...(options.gfm === false ? [] : [remarkGfm]),
        // The body field reports these; the TOC need not fail twice.
        ...(stage.kind === "code" ? [remarkRejectModuleCode] : []),
        ...(options.remarkPlugins ?? []),
      ],
      rehypePlugins,
    },
  );
  return String(file);
}

/**
 * Compile MDX to a JavaScript function body (render with `@anhur/mdx/react`).
 * With a field `context`, relative files are copied as assets and links
 * rewritten; headings get ids that match `s.toc()`.
 *
 * `sourceKind` `body` (default) compiles files with a Markdown extension
 * (`.md`) in MDX's Markdown format (no JSX / expressions / ESM; raw HTML is
 * kept); `field` always uses MDX. The `format` option overrides both.
 */
export function compileMdx(
  source: string,
  options: MdxOptions = {},
  context?: FieldContext,
  sourceKind: MdxSourceKind = "body",
): Promise<string> {
  return run(source, options, sourceKind, context, { kind: "code" });
}

/**
 * Headings of the compiled body with their ids, in document order. Runs the
 * same pipeline as {@link compileMdx} up to heading ids, without resolving
 * assets.
 */
export async function extractMdxHeadings(
  source: string,
  options: MdxOptions = {},
  context?: FieldContext,
): Promise<BodyHeading[]> {
  const headings: BodyHeading[] = [];
  await run(source, options, "body", context, { kind: "headings", headings });
  return headings;
}
