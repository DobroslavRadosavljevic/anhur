import {
  ASSETS_PROCESSOR_ID,
  defineProcessor,
  getDocumentMeta,
  type AssetsProcessorOptions,
  type ProcessorPlugin,
} from "@anhur/core";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import {
  isPassThroughUrl,
  requireAssetsProcessor,
  resolveAndEmit,
  resolveLocalPath,
} from "./resolve";
import { readSvgSize } from "./svg-meta";

export type { AssetsProcessorOptions };

export type AnhurImage = {
  src: string;
  width: number;
  height: number;
  blurDataURL: string;
  blurWidth: number;
  blurHeight: number;
};

export type AnhurFile = {
  src: string;
};

type ImageMeta = {
  width: number;
  height: number;
  blurDataURL: string;
  blurWidth: number;
  blurHeight: number;
};

const EMPTY_BLUR: Pick<ImageMeta, "blurDataURL" | "blurWidth" | "blurHeight"> =
  {
    blurDataURL: "",
    blurWidth: 0,
    blurHeight: 0,
  };

/**
 * Register the assets processor on `defineConfig({ processors })`.
 * Also enables body rewrite for `m.mdx()` / `md.markdown()` relative links.
 */
export function assets(
  options: AssetsProcessorOptions = {},
): ProcessorPlugin<AssetsProcessorOptions> {
  return defineProcessor(ASSETS_PROCESSOR_ID, options);
}

async function readRasterImageMeta(absolutePath: string): Promise<ImageMeta> {
  const metadata = await sharp(absolutePath).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  const blurWidth = 8;
  const blurHeight = 8;
  const blurBuffer = await sharp(absolutePath)
    .resize(blurWidth, blurHeight, { fit: "inside" })
    .webp({ quality: 20 })
    .toBuffer();

  return {
    width,
    height,
    blurDataURL: `data:image/webp;base64,${blurBuffer.toString("base64")}`,
    blurWidth,
    blurHeight,
  };
}

/**
 * SVG is copied as-is. Prefer sharp for size + blur placeholder when the
 * file can be rasterized; otherwise parse the SVG markup for dimensions.
 */
async function readSvgImageMeta(absolutePath: string): Promise<ImageMeta> {
  try {
    return await readRasterImageMeta(absolutePath);
  } catch {
    const size = await readSvgSize(absolutePath);
    return { ...size, ...EMPTY_BLUR };
  }
}

async function readImageMeta(absolutePath: string): Promise<ImageMeta> {
  if (path.extname(absolutePath).toLowerCase() === ".svg") {
    return readSvgImageMeta(absolutePath);
  }
  return readRasterImageMeta(absolutePath);
}

function imageField(): z.ZodType<AnhurImage> {
  return z.string().transform(async (value): Promise<AnhurImage> => {
    const meta = getDocumentMeta();
    requireAssetsProcessor(meta.path);

    if (isPassThroughUrl(value)) {
      return {
        src: value,
        width: 0,
        height: 0,
        blurDataURL: "",
        blurWidth: 0,
        blurHeight: 0,
      };
    }

    const absolute = await resolveLocalPath(value, meta.path);
    const src = await resolveAndEmit(value, meta.path);
    const imageMeta = await readImageMeta(absolute);
    return {
      src,
      ...imageMeta,
    };
  }) as unknown as z.ZodType<AnhurImage>;
}

function fileField(): z.ZodType<AnhurFile> {
  return z.string().transform(async (value): Promise<AnhurFile> => {
    const meta = getDocumentMeta();
    requireAssetsProcessor(meta.path);
    const src = await resolveAndEmit(value, meta.path);
    return { src };
  }) as unknown as z.ZodType<AnhurFile>;
}

/**
 * Asset schema helpers. Import as `import { schema as a } from "@anhur/assets"`.
 */
export const schema = {
  image: imageField,
  file: fileField,
};

export { ASSETS_PROCESSOR_ID };
