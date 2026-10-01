import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type sharpModule from "sharp";
import { MAX_SVG_BYTES, parseSvgSize } from "./svg";

/** Extensions `a.image()` can read sizes of (sharp's decoders plus SVG). */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);

/** Size and blur placeholder of a local image. */
export type ImageMeta = {
  readonly width: number;
  readonly height: number;
  readonly blurDataURL?: string;
  readonly blurWidth?: number;
  readonly blurHeight?: number;
};

type SharpFactory = typeof sharpModule;

async function loadSharp(): Promise<SharpFactory> {
  try {
    const module = await import("sharp");
    return module.default;
  } catch (cause) {
    throw new Error(
      'a.image() needs the "sharp" package to read image sizes. Install it: bun add sharp',
      { cause },
    );
  }
}

const BLUR_SIZE = 8;

/**
 * Width / height (EXIF orientation applied, so phone portraits are tall)
 * and an 8px WebP blur placeholder with its real size. SVG sizes come from
 * the markup; SVGs get no blur.
 */
export async function readImageMeta(
  filePath: string,
  options: { readonly blur: boolean },
): Promise<ImageMeta> {
  const extension = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(
      `cannot read the size of "${extension || "no extension"}" files. Use JPEG, PNG, WebP, AVIF, GIF, TIFF or SVG.`,
    );
  }
  if (extension === ".svg") {
    if ((await stat(filePath)).size > MAX_SVG_BYTES) {
      throw new Error(
        `the SVG is larger than ${MAX_SVG_BYTES / 1024 / 1024} MiB, too large to read its size.`,
      );
    }
    const size = parseSvgSize(await readFile(filePath, "utf8"));
    if (!size) {
      throw new Error(
        "the SVG has no size; add width/height or a viewBox to the <svg> tag.",
      );
    }
    return size;
  }
  const sharp = await loadSharp();
  let width: number;
  let height: number;
  try {
    const metadata = await sharp(filePath, { failOn: "error" }).metadata();
    width = metadata.autoOrient.width;
    height = metadata.autoOrient.height;
  } catch (cause) {
    throw new Error(
      `cannot read the image (${cause instanceof Error ? cause.message : String(cause)}). Use JPEG, PNG, WebP, AVIF, GIF, TIFF or SVG.`,
      { cause },
    );
  }
  if (!options.blur) return { width, height };
  const blur = await sharp(filePath)
    .autoOrient()
    .resize(BLUR_SIZE, BLUR_SIZE, { fit: "inside" })
    .webp({ quality: 20 })
    .toBuffer({ resolveWithObject: true });
  return {
    width,
    height,
    blurDataURL: `data:image/webp;base64,${blur.data.toString("base64")}`,
    blurWidth: blur.info.width,
    blurHeight: blur.info.height,
  };
}
