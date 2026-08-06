import { readFile } from "node:fs/promises";

export type SvgSize = {
  width: number;
  height: number;
};

/**
 * Read absolute width/height from the root `<svg>` tag.
 * Prefers numeric `width`/`height`, then `viewBox` size. Percentages are ignored.
 */
export function parseSvgSize(svgText: string): SvgSize {
  const root = svgText.match(/<svg\b[^>]*>/i)?.[0];
  if (!root) return { width: 0, height: 0 };

  const width = parseSvgLength(
    root.match(/\bwidth\s*=\s*["']([^"']+)["']/i)?.[1],
  );
  const height = parseSvgLength(
    root.match(/\bheight\s*=\s*["']([^"']+)["']/i)?.[1],
  );

  if (width != null && height != null) {
    return { width, height };
  }

  const viewBox = root.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1];
  if (viewBox) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (
      parts.length === 4 &&
      parts.every((n) => Number.isFinite(n)) &&
      parts[2]! > 0 &&
      parts[3]! > 0
    ) {
      return {
        width: width ?? parts[2]!,
        height: height ?? parts[3]!,
      };
    }
  }

  return { width: width ?? 0, height: height ?? 0 };
}

function parseSvgLength(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) return null;
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function readSvgSize(absolutePath: string): Promise<SvgSize> {
  const text = await readFile(absolutePath, "utf8");
  return parseSvgSize(text);
}
