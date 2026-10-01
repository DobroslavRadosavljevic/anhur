import { DOMParser, type Element, type Node } from "@xmldom/xmldom";

/** Width / height of an SVG in CSS pixels. */
export type SvgSize = {
  readonly width: number;
  readonly height: number;
};

/**
 * Version of {@link sanitizeSvg}. It is part of the output name of
 * sanitized SVGs, so a sanitizer change (or switching `svg: "keep"` to
 * `"sanitize"`) gives new names and copies / uploads them again.
 */
export const SVG_SANITIZER_VERSION = "svg-sanitize-1";

/** Largest SVG that is read into memory to measure or sanitize it. */
export const MAX_SVG_BYTES = 16 * 1024 * 1024;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const MAX_DEPTH = 256;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

const UNIT_TO_PX = new Map<string, number>([
  ["", 1],
  ["px", 1],
  ["pt", 4 / 3],
  ["pc", 16],
  ["mm", 96 / 25.4],
  ["cm", 96 / 2.54],
  ["in", 96],
]);

/** SVG elements kept by the sanitizer (everything else is dropped with its children). */
const ALLOWED_ELEMENTS = new Set([
  "a",
  "animate",
  "animateMotion",
  "animateTransform",
  "circle",
  "clipPath",
  "defs",
  "desc",
  "ellipse",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
  "filter",
  "g",
  "image",
  "line",
  "linearGradient",
  "marker",
  "mask",
  "mpath",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialGradient",
  "rect",
  "set",
  "stop",
  "style",
  "svg",
  "switch",
  "symbol",
  "text",
  "textPath",
  "title",
  "tspan",
  "use",
  "view",
]);

/** Elements that change another attribute over time (`attributeName`). */
const ANIMATION_ELEMENTS = new Set([
  "animate",
  "animateMotion",
  "animateTransform",
  "set",
]);

/** Elements whose `href` may embed a raster image as a `data:` URL. */
const IMAGE_ELEMENTS = new Set(["image", "feImage"]);

/** Attributes without a namespace kept by the sanitizer (compared in lowercase). */
const ALLOWED_ATTRIBUTES = new Set([
  "accent-height",
  "accumulate",
  "additive",
  "alignment-baseline",
  "amplitude",
  "ascent",
  "attributename",
  "attributetype",
  "azimuth",
  "basefrequency",
  "baseline-shift",
  "begin",
  "bias",
  "by",
  "calcmode",
  "class",
  "clip",
  "clip-path",
  "clip-rule",
  "clippathunits",
  "color",
  "color-interpolation",
  "color-interpolation-filters",
  "color-profile",
  "color-rendering",
  "cursor",
  "cx",
  "cy",
  "d",
  "diffuseconstant",
  "direction",
  "display",
  "divisor",
  "dominant-baseline",
  "dur",
  "dx",
  "dy",
  "edgemode",
  "elevation",
  "enable-background",
  "end",
  "exponent",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "filterunits",
  "flood-color",
  "flood-opacity",
  "font-family",
  "font-size",
  "font-size-adjust",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-weight",
  "fr",
  "from",
  "fx",
  "fy",
  "gradienttransform",
  "gradientunits",
  "height",
  "href",
  "id",
  "image-rendering",
  "in",
  "in2",
  "intercept",
  "isolation",
  "k",
  "k1",
  "k2",
  "k3",
  "k4",
  "kernelmatrix",
  "kernelunitlength",
  "kerning",
  "keypoints",
  "keysplines",
  "keytimes",
  "lang",
  "lengthadjust",
  "letter-spacing",
  "lighting-color",
  "marker-end",
  "marker-mid",
  "marker-start",
  "markerheight",
  "markerunits",
  "markerwidth",
  "mask",
  "mask-type",
  "maskcontentunits",
  "maskunits",
  "max",
  "media",
  "method",
  "min",
  "mix-blend-mode",
  "mode",
  "numoctaves",
  "offset",
  "opacity",
  "operator",
  "order",
  "orient",
  "orientation",
  "origin",
  "overflow",
  "paint-order",
  "path",
  "pathlength",
  "patterncontentunits",
  "patterntransform",
  "patternunits",
  "pointer-events",
  "points",
  "pointsatx",
  "pointsaty",
  "pointsatz",
  "preservealpha",
  "preserveaspectratio",
  "primitiveunits",
  "r",
  "radius",
  "refx",
  "refy",
  "repeatcount",
  "repeatdur",
  "restart",
  "result",
  "role",
  "rotate",
  "rx",
  "ry",
  "scale",
  "seed",
  "shape-rendering",
  "slope",
  "spacing",
  "specularconstant",
  "specularexponent",
  "spreadmethod",
  "startoffset",
  "stddeviation",
  "stitchtiles",
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "style",
  "surfacescale",
  "systemlanguage",
  "tabindex",
  "tablevalues",
  "targetx",
  "targety",
  "text-anchor",
  "text-decoration",
  "text-rendering",
  "textlength",
  "to",
  "transform",
  "transform-origin",
  "type",
  "unicode-bidi",
  "values",
  "vector-effect",
  "version",
  "viewbox",
  "visibility",
  "width",
  "word-spacing",
  "writing-mode",
  "x",
  "x1",
  "x2",
  "xchannelselector",
  "y",
  "y1",
  "y2",
  "ychannelselector",
  "z",
  "zoomandpan",
]);

const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i;

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE;
}

function isSvgElement(node: Node): node is Element {
  return isElement(node) && node.namespaceURI === SVG_NAMESPACE;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Parse SVG markup with a real XML parser. Any parser warning or error
 * rejects the file: a browser may read malformed markup differently.
 */
function parseSvgRoot(text: string): Element {
  const parser = new DOMParser({
    locator: false,
    onError: (level, message) => {
      throw new Error(`${level}: ${message}`);
    },
  });
  let root: Element | null;
  try {
    root = parser.parseFromString(text, "image/svg+xml").documentElement;
  } catch (cause) {
    throw new Error(`the SVG is not well-formed XML (${errorText(cause)}).`, {
      cause,
    });
  }
  if (!root || !isSvgElement(root) || root.localName !== "svg") {
    throw new Error(
      `the file is not an SVG: its root element must be <svg> in the ${SVG_NAMESPACE} namespace.`,
    );
  }
  return root;
}

function lengthToPx(value: string | null): number | undefined {
  if (value === null) return undefined;
  const match = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(
    value,
  );
  if (!match) return undefined;
  const factor = UNIT_TO_PX.get(match[2]!.toLowerCase());
  if (factor === undefined) return undefined;
  const px = Number(match[1]) * factor;
  return Number.isFinite(px) && px > 0 ? px : undefined;
}

/** Whole CSS pixels, at least 1; `undefined` when not a safe integer. */
function toPixels(value: number): number | undefined {
  const pixels = Math.max(1, Math.round(value));
  return Number.isSafeInteger(pixels) ? pixels : undefined;
}

function sizeOf(width: number, height: number): SvgSize | undefined {
  const w = toPixels(width);
  const h = toPixels(height);
  return w === undefined || h === undefined
    ? undefined
    : { width: w, height: h };
}

/**
 * Intrinsic size of an SVG: `width` / `height` (absolute units converted
 * to px; `%` / `em` ignored), completed from the `viewBox` aspect ratio.
 * Sizes are whole pixels, at least 1. Returns `undefined` when neither
 * gives a usable size (missing, or not a safe integer); throws when the markup is not a well-formed SVG.
 */
export function parseSvgSize(text: string): SvgSize | undefined {
  const root = parseSvgRoot(text);
  const width = lengthToPx(root.getAttribute("width"));
  const height = lengthToPx(root.getAttribute("height"));
  const viewBox = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const box =
    viewBox &&
    viewBox.length === 4 &&
    viewBox.every(Number.isFinite) &&
    viewBox[2]! > 0 &&
    viewBox[3]! > 0
      ? { width: viewBox[2]!, height: viewBox[3]! }
      : undefined;
  if (width !== undefined && height !== undefined) {
    return sizeOf(width, height);
  }
  if (!box) return undefined;
  if (width !== undefined) {
    return sizeOf(width, (width * box.height) / box.width);
  }
  if (height !== undefined) {
    return sizeOf((height * box.width) / box.height, height);
  }
  return sizeOf(box.width, box.height);
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
}

/** Drop spaces and C0 / C1 control characters. */
function withoutControlCharacters(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += char;
  }
  return out;
}

/**
 * True for `#fragment`, relative and `http(s):` URLs (and raster `data:`
 * images where allowed). The value is already entity-decoded by the parser;
 * whitespace and control characters are removed first, as browsers ignore
 * them inside schemes (`java&#9;script:`).
 */
function isSafeUrl(value: string, allowRasterData: boolean): boolean {
  const compact = withoutControlCharacters(value);
  if (compact === "" || compact.startsWith("#")) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  if (!scheme) return true;
  const name = scheme[1]!.toLowerCase();
  if (name === "http" || name === "https") return true;
  return allowRasterData && RASTER_DATA_URL.test(compact);
}

/** Target of an animation element (`xlink:href` → `href`), lowercase. */
function animatedAttribute(element: Element): string {
  const raw = element.getAttribute("attributeName") ?? "";
  return raw
    .trim()
    .replace(/^[^:]*:/, "")
    .toLowerCase();
}

/** Animations may not change links or event handlers. */
function isUnsafeAnimation(element: Element, localName: string): boolean {
  if (!ANIMATION_ELEMENTS.has(localName)) return false;
  const target = animatedAttribute(element);
  return target === "href" || target.startsWith("on");
}

type SerializeState = { usesXlink: boolean };

function serializeAttributes(
  element: Element,
  localName: string,
  state: SerializeState,
): string {
  let out = "";
  const allowRasterData = IMAGE_ELEMENTS.has(localName);
  for (const attribute of element.attributes) {
    const name = attribute.localName ?? attribute.name;
    const value = attribute.value;
    if (attribute.namespaceURI === XLINK_NAMESPACE) {
      if (name !== "href" || !isSafeUrl(value, allowRasterData)) continue;
      state.usesXlink = true;
      out += ` xlink:href="${escapeAttribute(value)}"`;
      continue;
    }
    if (attribute.namespaceURI === XML_NAMESPACE) {
      if (name === "space" || name === "lang") {
        out += ` xml:${name}="${escapeAttribute(value)}"`;
      }
      continue;
    }
    if (attribute.namespaceURI !== null) continue;
    const lower = name.toLowerCase();
    const allowed =
      ALLOWED_ATTRIBUTES.has(lower) ||
      /^aria-[a-z]+$/.test(lower) ||
      /^data-[a-z0-9-]+$/.test(lower);
    if (!allowed) continue;
    if (lower === "href" && !isSafeUrl(value, allowRasterData)) continue;
    out += ` ${name}="${escapeAttribute(value)}"`;
  }
  return out;
}

function serializeElement(
  element: Element,
  depth: number,
  state: SerializeState,
): string {
  if (depth > MAX_DEPTH) {
    throw new Error(`the SVG is nested more than ${MAX_DEPTH} levels deep.`);
  }
  const localName = element.localName ?? "";
  if (!ALLOWED_ELEMENTS.has(localName)) return "";
  if (isUnsafeAnimation(element, localName)) return "";
  const attributes = serializeAttributes(element, localName, state);
  let children = "";
  for (const child of element.childNodes) {
    if (isSvgElement(child)) {
      children += serializeElement(child, depth + 1, state);
    } else if (
      child.nodeType === TEXT_NODE ||
      child.nodeType === CDATA_SECTION_NODE
    ) {
      children += escapeText(child.nodeValue ?? "");
    }
  }
  return children === ""
    ? `<${localName}${attributes}/>`
    : `<${localName}${attributes}>${children}</${localName}>`;
}

/**
 * Rebuild an SVG from an allowlist so it is safe to serve from the site
 * origin. The markup is parsed as XML (malformed files are rejected), then
 * only SVG-namespace elements and presentation attributes are written back:
 * no `<script>`, `<foreignObject>`, foreign (XHTML) elements, event
 * handlers, comments or processing instructions. `href` / `xlink:href`
 * keep only `#fragment`, relative and `http(s):` URLs (plus raster
 * `data:` images on `<image>` / `<feImage>`), and animations that target
 * links or event handlers are removed. Defense in depth: also serve SVGs
 * with a restrictive `Content-Security-Policy`.
 */
export function sanitizeSvg(text: string): string {
  const root = parseSvgRoot(text);
  const state: SerializeState = { usesXlink: false };
  const body = serializeElement(root, 0, state);
  const namespaces = state.usesXlink
    ? ` xmlns="${SVG_NAMESPACE}" xmlns:xlink="${XLINK_NAMESPACE}"`
    : ` xmlns="${SVG_NAMESPACE}"`;
  return body.replace(/^<svg/, `<svg${namespaces}`);
}

/** How copied SVGs are handled. */
export type SvgMode = "sanitize" | "keep";

/**
 * Transform version of a copied file (see `AssetHost.transformVersion` in
 * `@anhur/core`): sanitized SVGs get {@link SVG_SANITIZER_VERSION}, other
 * files are copied as is.
 */
export function svgTransformVersion(
  extension: string,
  mode: SvgMode,
): string | undefined {
  return mode === "sanitize" && extension.toLowerCase() === ".svg"
    ? SVG_SANITIZER_VERSION
    : undefined;
}
