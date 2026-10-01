import { contentTypeForExtension } from "../mime";
import { slugify } from "../naming";

/** What a URL found in a document points at. */
export type UrlClass =
  | { readonly kind: "empty" }
  /** `https:`, `mailto:`, `data:`, `//host/…` and any other scheme. */
  | { readonly kind: "external" }
  /** `/path` — resolved by the host app, not by Anhur. */
  | { readonly kind: "root" }
  /** `#anchor` */
  | { readonly kind: "fragment" }
  /** `?page=2` */
  | { readonly kind: "query" }
  /** `./file.png`, `../guide/`, `image.png?w=1#x` */
  | {
      readonly kind: "relative";
      /** Decoded path part. */
      readonly path: string;
      /** `?query` / `#hash` suffix, kept as written. */
      readonly suffix: string;
    };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

/** Classify a URL. Any scheme is external, so `javascript:` never reaches the file system. */
export function classifyUrl(raw: string): UrlClass {
  const url = raw.trim();
  if (url.length === 0) return { kind: "empty" };
  if (url.startsWith("//")) return { kind: "external" };
  if (SCHEME.test(url) && !WINDOWS_DRIVE.test(url)) {
    return { kind: "external" };
  }
  if (url.startsWith("/")) return { kind: "root" };
  if (url.startsWith("#")) return { kind: "fragment" };
  if (url.startsWith("?")) return { kind: "query" };
  const cut = url.search(/[?#]/);
  const pathPart = cut < 0 ? url : url.slice(0, cut);
  const suffix = cut < 0 ? "" : url.slice(cut);
  let decoded = pathPart;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    decoded = pathPart;
  }
  return { kind: "relative", path: decoded, suffix };
}

/** Extensions of pages: links to them are never copied as files. */
const PAGE_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".html", ".htm"]);

const UNKNOWN_CONTENT_TYPE = contentTypeForExtension("");

/** Common download types without a content type in the MIME table. */
const FILE_EXTENSIONS = new Set([
  ".7z",
  ".apk",
  ".bz2",
  ".css",
  ".dmg",
  ".exe",
  ".glb",
  ".gltf",
  ".heic",
  ".ics",
  ".js",
  ".jxl",
  ".mid",
  ".mjs",
  ".mkv",
  ".msi",
  ".odp",
  ".ods",
  ".odt",
  ".psd",
  ".rar",
  ".rtf",
  ".stl",
  ".tar",
  ".tgz",
  ".toml",
  ".xz",
  ".yaml",
  ".yml",
]);

/** Lowercase extension of the last path segment (`.png`), or `""`. */
function linkExtension(relativePath: string): string {
  const base = relativePath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * True when a relative link (`<a href>`) points at a file to copy: its
 * extension is a known file type (`.png`, `.pdf`, `.zip`, `.yaml`, …) or one of
 * `allowedExtensions` (the asset host's `extensions`), and not a page
 * extension (`.md`, `.mdx`, `.markdown`, `.html`, `.htm`).
 *
 * Directories (`../guide/`), extensionless paths (`./intro`), versions
 * (`./release-1.0`) and pages are links to other pages.
 */
export function isAssetLinkPath(
  relativePath: string,
  allowedExtensions?: readonly string[],
): boolean {
  if (/[\\/]$/.test(relativePath)) return false;
  const extension = linkExtension(relativePath);
  if (extension === "" || PAGE_EXTENSIONS.has(extension)) return false;
  if (allowedExtensions?.includes(extension)) return true;
  if (FILE_EXTENSIONS.has(extension)) return true;
  return contentTypeForExtension(extension) !== UNKNOWN_CONTENT_TYPE;
}

/**
 * True when a relative link points at a page rather than a file (the
 * opposite of {@link isAssetLinkPath}): a directory, an extensionless path,
 * a version-like name (`./release-1.0`), or a Markdown / MDX / HTML page.
 */
export function isDocumentLinkPath(
  relativePath: string,
  allowedExtensions?: readonly string[],
): boolean {
  return !isAssetLinkPath(relativePath, allowedExtensions);
}

/** True when any path segment is a dotfile / dot-directory (`.env`, `.git/x`). */
export function hasDotSegment(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some(
      (segment) =>
        segment.startsWith(".") && segment !== "." && segment !== "..",
    );
}

export type SrcsetCandidate = {
  readonly url: string;
  /** `2x`, `800w`, or empty. */
  readonly descriptor: string;
};

/**
 * Parse `srcset` following the HTML algorithm: a URL runs until whitespace
 * (so `data:` URLs with commas stay whole), trailing commas end it, and the
 * descriptor runs until the next comma.
 */
export function parseSrcset(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let index = 0;
  const length = value.length;
  while (index < length) {
    while (index < length && /[\s,]/.test(value[index]!)) index += 1;
    if (index >= length) break;
    let url = "";
    while (index < length && !/\s/.test(value[index]!)) {
      url += value[index];
      index += 1;
    }
    let endedWithComma = false;
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
      endedWithComma = true;
    }
    let descriptor = "";
    if (!endedWithComma) {
      let depth = 0;
      while (index < length) {
        const char = value[index]!;
        if (char === "(") depth += 1;
        if (char === ")") depth = Math.max(0, depth - 1);
        if (char === "," && depth === 0) break;
        descriptor += char;
        index += 1;
      }
    }
    if (url.length > 0) {
      candidates.push({ url, descriptor: descriptor.trim() });
    }
  }
  return candidates;
}

/** Serialize candidates back into a `srcset` value. */
export function serializeSrcset(
  candidates: readonly SrcsetCandidate[],
): string {
  return candidates
    .map((candidate) =>
      candidate.descriptor
        ? `${candidate.url} ${candidate.descriptor}`
        : candidate.url,
    )
    .join(", ");
}

/**
 * Content-hashed, URL-safe output file name for an asset:
 * `My Photo.JPG` + hash → `my-photo-1a2b3c4d5e6f7a8b.jpg`.
 */
export function assetFileName(sourceBaseName: string, hash: string): string {
  const dot = sourceBaseName.lastIndexOf(".");
  const stem = dot > 0 ? sourceBaseName.slice(0, dot) : sourceBaseName;
  const rawExtension = dot > 0 ? sourceBaseName.slice(dot).toLowerCase() : "";
  const extension = /^\.[a-z0-9]{1,16}$/.test(rawExtension) ? rawExtension : "";
  const base = slugify(stem).slice(0, 64) || "asset";
  return `${base}-${hash}${extension}`;
}
