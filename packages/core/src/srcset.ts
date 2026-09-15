export type SrcsetCandidate = {
  url: string;
  /** Density (`1x`), width (`800w`), or empty. */
  descriptor: string;
};

const HTML_ASSET_ATTR =
  /(?<![\w-])(srcset|imagesrcset|src|href|poster)\s*=\s*(["'])([^"']*)\2/gi;

const LINKED_ATTR_NAMES = new Set([
  "href",
  "src",
  "poster",
  "srcset",
  "imagesrcset",
]);

/** `srcset` / `srcSet` / `imagesrcset` / `imageSrcSet`. */
export function isSrcsetAttrName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "srcset" || lower === "imagesrcset";
}

/** HTML/JSX attributes that may hold a relative asset URL (or a srcset list). */
export function isLinkedAssetAttrName(name: string): boolean {
  return LINKED_ATTR_NAMES.has(name.toLowerCase());
}

/**
 * Parse a srcset/imagesrcset attribute into URL + descriptor pairs.
 * Comma-separated candidates; URLs with embedded commas (data URIs) are not split further.
 */
export function parseSrcset(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  for (const raw of value.split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\S+)(?:\s+(.*))?$/);
    if (!match) continue;
    candidates.push({
      url: match[1]!,
      descriptor: (match[2] ?? "").trim(),
    });
  }
  return candidates;
}

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

export function collectSrcsetUrls(value: string): string[] {
  return parseSrcset(value).map((candidate) => candidate.url);
}

export function mapSrcsetUrls(
  value: string,
  mapUrl: (url: string) => string,
): string {
  return serializeSrcset(
    parseSrcset(value).map((candidate) => ({
      ...candidate,
      url: mapUrl(candidate.url),
    })),
  );
}

export function matchHtmlAssetAttrs(
  html: string,
): Array<{ name: string; value: string }> {
  const pattern = new RegExp(HTML_ASSET_ATTR.source, HTML_ASSET_ATTR.flags);
  const found: Array<{ name: string; value: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    found.push({ name: match[1]!, value: match[3]! });
  }
  return found;
}

/** Every URL in `src`/`href`/`poster` plus each srcset candidate. */
export function collectHtmlAssetUrls(html: string): string[] {
  const urls: string[] = [];
  for (const attr of matchHtmlAssetAttrs(html)) {
    if (isSrcsetAttrName(attr.name)) {
      urls.push(...collectSrcsetUrls(attr.value));
    } else {
      urls.push(attr.value);
    }
  }
  return urls;
}

/**
 * Replace one relative URL wherever it appears as a simple linked attr
 * or as a srcset candidate. Leaves other candidates and descriptors intact.
 */
export function rewriteHtmlAssetAttrValue(
  html: string,
  from: string,
  to: string,
): string {
  const pattern = new RegExp(HTML_ASSET_ATTR.source, HTML_ASSET_ATTR.flags);
  return html.replace(
    pattern,
    (full, name: string, quote: string, value: string) => {
      const eq = full.indexOf("=");
      if (isSrcsetAttrName(name)) {
        const next = mapSrcsetUrls(value, (url) => (url === from ? to : url));
        if (next === value) return full;
        return `${full.slice(0, eq)}=${quote}${next}${quote}`;
      }
      if (value !== from) return full;
      return `${full.slice(0, eq)}=${quote}${to}${quote}`;
    },
  );
}
