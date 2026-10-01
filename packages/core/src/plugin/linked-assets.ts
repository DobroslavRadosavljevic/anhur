import path from "node:path";
import { Predicate } from "effect";
import type { Element, Root } from "hast";
import { visit } from "unist-util-visit";
import { classifyUrl, parseSrcset, serializeSrcset } from "./links";
import type { FieldContext, FieldDocument, LinkRole } from "./types";

/** A relative link to another page, passed to a {@link DocumentLinkResolver}. */
export type DocumentLink = {
  /** URL as written (`./intro.md?tab=1#setup`). */
  readonly url: string;
  /** Decoded path part, relative to the document (`./intro.md`). */
  readonly path: string;
  /** `?query` / `#hash` as written (`?tab=1#setup`), or `""`. */
  readonly suffix: string;
  /**
   * Linked file (or directory) relative to the project directory, POSIX
   * separators, no trailing slash (`content/docs/intro.md`).
   */
  readonly target: string;
  /** The document that contains the link. */
  readonly document: FieldDocument;
};

/**
 * Maps a relative link to another page (`./intro.md`, `../guide/`) to a
 * public URL. Return the URL without `?query` / `#hash`: Anhur appends
 * {@link DocumentLink.suffix}. Return `undefined` to keep the link as written.
 */
export type DocumentLinkResolver = (link: DocumentLink) => string | undefined;

export type LinkedAssetsOptions = {
  readonly context: FieldContext;
  /** Rewrite links to other documents; unchanged when omitted or `undefined` is returned. */
  readonly documentLink?: DocumentLinkResolver;
};

type Occurrence = {
  readonly url: string;
  readonly role: LinkRole;
  readonly apply: (next: string) => void;
};

type AttributeRule = {
  readonly prop: string;
  readonly role: LinkRole;
  readonly srcset?: boolean;
  /**
   * Only rewrite `./x` / `../x` values. Set for props of MDX components,
   * where `src="dQw4w9WgXcQ"` is usually an id, not a file.
   */
  readonly explicitOnly?: boolean;
};

const CITE: readonly AttributeRule[] = [{ prop: "cite", role: "link" }];

/** hast elements and properties that hold URLs (raw HTML or Markdown). */
const ELEMENT_RULES = new Map<string, readonly AttributeRule[]>([
  [
    "img",
    [
      { prop: "src", role: "image" },
      { prop: "srcSet", role: "image", srcset: true },
    ],
  ],
  [
    "source",
    [
      { prop: "src", role: "media" },
      { prop: "srcSet", role: "image", srcset: true },
    ],
  ],
  [
    "video",
    [
      { prop: "src", role: "media" },
      { prop: "poster", role: "image" },
    ],
  ],
  ["audio", [{ prop: "src", role: "media" }]],
  ["track", [{ prop: "src", role: "media" }]],
  ["embed", [{ prop: "src", role: "media" }]],
  ["object", [{ prop: "data", role: "media" }]],
  ["iframe", [{ prop: "src", role: "link" }]],
  ["input", [{ prop: "src", role: "image" }]],
  ["link", [{ prop: "href", role: "link" }]],
  [
    "a",
    [
      { prop: "href", role: "link" },
      { prop: "xLinkHref", role: "link" },
    ],
  ],
  ["area", [{ prop: "href", role: "link" }]],
  [
    "image",
    [
      { prop: "href", role: "image" },
      { prop: "xLinkHref", role: "image" },
    ],
  ],
  [
    "use",
    [
      { prop: "href", role: "image" },
      { prop: "xLinkHref", role: "image" },
    ],
  ],
  ["blockquote", CITE],
  ["q", CITE],
  ["del", CITE],
  ["ins", CITE],
]);

/** Element whose `src` is an image (`<img>`, `<input type="image">`). */
const IMAGE_SRC = new Set(["img", "input"]);
/** SVG elements whose `href` references an image or sprite. */
const IMAGE_HREF = new Set(["image", "use"]);

/** A JSX element name, and whether it is a component (not an HTML tag). */
type JsxElementName = {
  readonly name: string | undefined;
  readonly component: boolean;
};

/**
 * JSX naming rule: lower-case names (`img`, `my-element`, `svg:rect`) are
 * HTML / SVG elements; capitalized names (`Figure`) and member expressions
 * (`Foo.Bar`) are components.
 */
function jsxElementName(name: string | null | undefined): JsxElementName {
  if (!name) return { name: undefined, component: false };
  const component = name.includes(".") || !/^[a-z]/.test(name);
  return { name, component };
}

/** JSX attribute → URL rule, for MDX JSX elements and JSX in expressions / ESM. */
function jsxAttributeRule(
  element: JsxElementName,
  attribute: string,
): AttributeRule | undefined {
  const lower = attribute.toLowerCase();
  const tag = element.component ? undefined : element.name;
  let role: LinkRole | undefined;
  let srcset = false;
  if (lower === "srcset" || lower === "imagesrcset") {
    role = "image";
    srcset = true;
  } else if (lower === "src") {
    if (tag !== undefined && IMAGE_SRC.has(tag)) role = "image";
    else if (tag === "iframe") role = "link";
    else role = "media";
  } else if (lower === "poster") {
    role = "image";
  } else if (
    lower === "href" ||
    lower === "xlinkhref" ||
    lower === "xlink:href"
  ) {
    role = tag !== undefined && IMAGE_HREF.has(tag) ? "image" : "link";
  } else if (lower === "cite") {
    role = "link";
  } else if (lower === "data" && tag === "object") {
    role = "media";
  }
  if (role === undefined) return undefined;
  return {
    prop: attribute,
    role,
    srcset,
    explicitOnly: element.component,
  };
}

const EXPLICIT_RELATIVE = /^\.\.?[\\/]/;

function addValue(
  found: Occurrence[],
  value: string,
  rule: AttributeRule,
  write: (next: string) => void,
): void {
  const wanted = (url: string) =>
    !rule.explicitOnly || EXPLICIT_RELATIVE.test(url.trim());
  if (!rule.srcset) {
    if (wanted(value))
      found.push({ url: value, role: rule.role, apply: write });
    return;
  }
  const candidates = parseSrcset(value);
  const next = candidates.map((candidate) => ({ ...candidate }));
  const indexes = candidates
    .map((candidate, index) => (wanted(candidate.url) ? index : -1))
    .filter((index) => index >= 0);
  let pending = indexes.length;
  for (const index of indexes) {
    const candidate = candidates[index]!;
    found.push({
      url: candidate.url,
      role: rule.role,
      apply: (url) => {
        next[index] = { url, descriptor: candidate.descriptor };
        pending -= 1;
        if (pending === 0) write(serializeSrcset(next));
      },
    });
  }
}

function collectElement(node: Element, found: Occurrence[]): void {
  const rules = ELEMENT_RULES.get(node.tagName);
  if (!rules) return;
  for (const rule of rules) {
    const value = node.properties[rule.prop];
    if (Predicate.isString(value)) {
      addValue(found, value, rule, (next) => {
        node.properties[rule.prop] = next;
      });
    } else if (Array.isArray(value) && rule.srcset) {
      const joined = value.map(String).join(", ");
      addValue(found, joined, rule, (next) => {
        node.properties[rule.prop] = next;
      });
    }
  }
}

/** Minimal ESTree view (MDX expressions carry `data.estree`). */
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

type WritableLiteral = { type: "Literal"; value: string; raw?: string };

function isStringLiteral<T>(value: T): value is T & WritableLiteral {
  return (
    isEstreeNode(value) &&
    value.type === "Literal" &&
    Predicate.isString(value.value)
  );
}

/**
 * Name of a JSX element or attribute: `img`, `Foo.Bar` (member
 * expression), `xlink:href` (namespaced name).
 */
function jsxName(value: EstreeValue): string | undefined {
  if (!isEstreeNode(value)) return undefined;
  if (value.type === "JSXIdentifier" && Predicate.isString(value.name)) {
    return value.name;
  }
  if (value.type === "JSXMemberExpression") {
    const object = jsxName(value.object);
    const property = jsxName(value.property);
    return object && property ? `${object}.${property}` : undefined;
  }
  if (value.type === "JSXNamespacedName") {
    const namespace = jsxName(value.namespace);
    const name = jsxName(value.name);
    return namespace && name ? `${namespace}:${name}` : undefined;
  }
  return undefined;
}

/** String literal of a JSX attribute value (`src="x"` or `src={"x"}`). */
function attributeLiteral(value: EstreeValue): WritableLiteral | undefined {
  if (isStringLiteral(value)) return value;
  if (isEstreeNode(value) && value.type === "JSXExpressionContainer") {
    const expression = value.expression;
    if (isStringLiteral(expression)) return expression;
  }
  return undefined;
}

function rewriteLiteral(literal: WritableLiteral, next: string): void {
  literal.value = next;
  literal.raw = JSON.stringify(next);
}

function collectEstree(
  value: EstreeValue,
  found: Occurrence[],
  depth: number,
): void {
  if (depth > 512) return;
  if (Array.isArray(value)) {
    for (const item of value) collectEstree(item, found, depth + 1);
    return;
  }
  if (!isEstreeNode(value)) return;
  if (value.type === "JSXElement") {
    const opening = value.openingElement;
    if (isEstreeNode(opening) && Array.isArray(opening.attributes)) {
      const element = jsxElementName(jsxName(opening.name));
      for (const attribute of opening.attributes) {
        if (!isEstreeNode(attribute) || attribute.type !== "JSXAttribute") {
          continue;
        }
        const name = jsxName(attribute.name);
        if (!name) continue;
        const rule = jsxAttributeRule(element, name);
        const literal = attributeLiteral(attribute.value);
        if (rule && literal) {
          addValue(found, literal.value, rule, (next) => {
            rewriteLiteral(literal, next);
          });
        }
      }
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "type" || key === "loc" || key === "range") continue;
    collectEstree(child, found, depth + 1);
  }
}

type MdxJsxAttribute = {
  type: string;
  name?: string;
  /** `{...props}` spread attributes carry their estree here. */
  data?: { estree?: EstreeValue };
  value?:
    | string
    | null
    | {
        type: string;
        value: string;
        data?: { estree?: EstreeValue };
      };
};

type MdxJsxNode = {
  type: "mdxJsxFlowElement" | "mdxJsxTextElement";
  name?: string | null;
  attributes: MdxJsxAttribute[];
};

/** MDX nodes whose `data.estree` holds JavaScript (`{…}` and `export …`). */
type MdxEstreeNode = {
  type: "mdxFlowExpression" | "mdxTextExpression" | "mdxjsEsm";
  data?: { estree?: EstreeValue };
};

function isMdxJsxNode<T>(value: T): value is T & MdxJsxNode {
  return (
    isEstreeNode(value) &&
    (value.type === "mdxJsxFlowElement" ||
      value.type === "mdxJsxTextElement") &&
    Array.isArray(value.attributes)
  );
}

function isMdxEstreeNode<T>(value: T): value is T & MdxEstreeNode {
  return (
    isEstreeNode(value) &&
    (value.type === "mdxFlowExpression" ||
      value.type === "mdxTextExpression" ||
      value.type === "mdxjsEsm")
  );
}

function expressionLiteral(
  estree: EstreeValue | undefined,
): WritableLiteral | undefined {
  if (!isEstreeNode(estree) || !Array.isArray(estree.body)) return undefined;
  const [statement] = estree.body;
  if (!isEstreeNode(statement) || statement.type !== "ExpressionStatement") {
    return undefined;
  }
  const expression = statement.expression;
  return isStringLiteral(expression) ? expression : undefined;
}

function collectMdxJsx(node: MdxJsxNode, found: Occurrence[]): void {
  const element = jsxElementName(node.name);
  for (const attribute of node.attributes) {
    if (attribute.type !== "mdxJsxAttribute" || !attribute.name) {
      // `{...props}` spreads may still contain JSX with URLs.
      if (attribute.data?.estree) {
        collectEstree(attribute.data.estree, found, 0);
      }
      continue;
    }
    const rule = jsxAttributeRule(element, attribute.name);
    const value = attribute.value;
    if (Predicate.isString(value)) {
      if (rule) {
        addValue(found, value, rule, (next) => {
          attribute.value = next;
        });
      }
    } else if (value && value.type === "mdxJsxAttributeValueExpression") {
      const literal = rule ? expressionLiteral(value.data?.estree) : undefined;
      if (rule && literal) {
        addValue(found, literal.value, rule, (next) => {
          rewriteLiteral(literal, next);
          value.value = JSON.stringify(next);
        });
      } else if (value.data?.estree) {
        collectEstree(value.data.estree, found, 0);
      }
    }
  }
}

/** Project-relative POSIX path of a link target, without a trailing slash. */
function linkTarget(context: FieldContext, linkPath: string): string {
  const absolute = path.resolve(
    path.dirname(context.document.filePath),
    linkPath,
  );
  return path.relative(context.projectDir, absolute).split(path.sep).join("/");
}

/**
 * Rehype plugin that finds every URL in elements (`img`, `source`, `video`,
 * `a`, `iframe`, `use`, …), MDX JSX attributes, and JSX inside MDX
 * expressions and `export` blocks, then:
 * - copies relative files through {@link FieldContext.resolveLink} and
 *   rewrites them to their public URL,
 * - leaves external URLs, root paths, anchors and queries alone,
 * - passes links to other pages through `documentLink` (or keeps them).
 *
 * Props of MDX components (`<Figure src>`, `<Docs.Link href>`) are only
 * rewritten when the value starts with `./` or `../`.
 *
 * Runs on HTML elements after `rehype-raw` (and after sanitizing), so
 * attributes in comments, text or removed elements are never treated as
 * links.
 */
export function rehypeLinkedAssets(options: LinkedAssetsOptions) {
  return async (tree: Root): Promise<void> => {
    const found: Occurrence[] = [];
    visit(tree, (node) => {
      if (node.type === "element") {
        collectElement(node, found);
        return;
      }
      // MDX nodes are not part of the hast types; inspect them structurally.
      const loose: { readonly type: string } = node;
      if (isMdxJsxNode(loose)) {
        collectMdxJsx(loose, found);
        return;
      }
      if (isMdxEstreeNode(loose) && loose.data?.estree) {
        collectEstree(loose.data.estree, found, 0);
      }
    });
    if (found.length === 0) return;

    const { context, documentLink } = options;
    const resolved = new Map<string, Promise<string>>();
    const resolve = (url: string, role: LinkRole): Promise<string> => {
      const key = `${role}\u0000${url}`;
      let pending = resolved.get(key);
      if (!pending) {
        pending = context.resolveLink(url, role).then((link) => {
          if (link.kind !== "document" || !documentLink) return link.url;
          const classified = classifyUrl(link.url);
          const suffix =
            classified.kind === "relative" ? classified.suffix : "";
          const mapped = documentLink({
            url: link.url,
            path: link.path,
            suffix,
            target: linkTarget(context, link.path),
            document: context.document,
          });
          return mapped === undefined ? link.url : `${mapped}${suffix}`;
        });
        resolved.set(key, pending);
      }
      return pending;
    };

    const results = await Promise.all(
      found.map((occurrence) => resolve(occurrence.url, occurrence.role)),
    );
    found.forEach((occurrence, index) => {
      occurrence.apply(results[index]!);
    });
  };
}
