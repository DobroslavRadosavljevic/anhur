import path from "node:path";
import {
  classifyUrl,
  defineField,
  installedVersion,
  type FieldContext,
  type FieldInput,
  type ResolvedLink,
} from "@anhur/core/plugin";
import { z } from "zod";
import { IMAGE_EXTENSIONS, readImageMeta } from "./image-meta";
import { ASSETS_PLUGIN } from "./plugin";

/** A local image copied as an asset, with its size. */
export type AnhurImage = {
  src: string;
  width: number;
  height: number;
  contentType: string;
  /** 8px WebP placeholder (raster images only). */
  blurDataURL?: string;
  blurWidth?: number;
  blurHeight?: number;
};

/** An image URL kept as written (`allowRemote: true`); no size is known. */
export type RemoteImage = {
  src: string;
  remote: true;
};

/** A local file copied as an asset. */
export type AnhurFile = {
  src: string;
  size: number;
  contentType: string;
};

const AnhurImageSchema = z.object({
  src: z.string(),
  width: z.number(),
  height: z.number(),
  contentType: z.string(),
  blurDataURL: z.string().optional(),
  blurWidth: z.number().optional(),
  blurHeight: z.number().optional(),
});

const RemoteImageSchema = z.object({
  src: z.string(),
  remote: z.literal(true),
});

const AnhurFileSchema = z.object({
  src: z.string(),
  size: z.number(),
  contentType: z.string(),
});

const SHARP_VERSION = installedVersion("sharp", import.meta.url);

function isString(value: FieldInput): value is string {
  return typeof value === "string";
}

/** `http(s)://…`, `//host/…` or a root path `/…`: the URLs `allowRemote` keeps. */
function isRemoteSource(url: string): boolean {
  return /^https?:\/\//i.test(url) || url.startsWith("/");
}

async function resolveLocal(
  input: FieldInput,
  context: FieldContext,
  role: "image" | "media",
  allowRemote: boolean,
  helper: string,
): Promise<Extract<ResolvedLink, { kind: "asset" }> | RemoteImage> {
  if (!isString(input) || input.trim().length === 0) {
    throw new Error(`${helper} needs a file path.`);
  }
  const link = await context.resolveLink(input, role);
  if (link.kind === "asset") return link;
  if (!allowRemote) {
    throw new Error(
      `${helper} needs a path relative to the document (got "${input}"). Pass { allowRemote: true } to keep URLs as written.`,
    );
  }
  const url = input.trim();
  if (!isRemoteSource(url)) {
    throw new Error(
      `${helper} keeps only http(s) URLs, protocol-relative URLs (//host/…) and root paths (/…) as written (got "${input}").`,
    );
  }
  return { src: url, remote: true };
}

/** a.image() reads sizes of these formats only (`.ico`, `.bmp` → use a.file()). */
function checkImageExtension(input: FieldInput): void {
  if (!isString(input)) return;
  const classified = classifyUrl(input);
  if (classified.kind !== "relative") return;
  const extension = path.extname(classified.path).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(
      `a.image() reads AVIF, GIF, JPEG, PNG, SVG, TIFF and WebP files (got "${extension || "no extension"}"). Use a.file() for other files.`,
    );
  }
}

export type ImageOptions = {
  /** Keep absolute / root URLs as `{ src, remote: true }` instead of failing. Default `false`. */
  readonly allowRemote?: boolean;
  /** Add a blur placeholder for raster images. Default `true`. */
  readonly blur?: boolean;
};

/**
 * Local image (path relative to the document): copied as an asset, with
 * width / height (EXIF orientation applied) and a blur placeholder.
 */
export function image(
  options?: ImageOptions & { readonly allowRemote?: false },
): z.ZodType<AnhurImage>;
export function image(
  options: ImageOptions & { readonly allowRemote: true },
): z.ZodType<AnhurImage | RemoteImage>;
export function image(
  options: ImageOptions = {},
): z.ZodType<AnhurImage | RemoteImage> {
  const allowRemote = options.allowRemote === true;
  const blur = options.blur !== false;
  const output = allowRemote
    ? z.union([AnhurImageSchema, RemoteImageSchema])
    : AnhurImageSchema;
  return defineField(output, {
    kind: "image",
    requires: ASSETS_PLUGIN,
    whenAbsent: "skip",
    cache: {
      version: `image-2;sharp@${SHARP_VERSION}`,
      key: () => (blur ? "blur" : "plain"),
    },
    compile: async (input, context) => {
      checkImageExtension(input);
      const link = await resolveLocal(
        input,
        context,
        "image",
        allowRemote,
        "a.image()",
      );
      if (!("kind" in link)) return link;
      const meta = await readImageMeta(link.asset.sourcePath, { blur });
      const result: AnhurImage = {
        src: link.url,
        contentType: link.asset.contentType,
        ...meta,
      };
      return result;
    },
  });
}

export type FileOptions = {
  /** Keep absolute / root URLs as `{ src, remote: true }` instead of failing. Default `false`. */
  readonly allowRemote?: boolean;
};

/** Local file (path relative to the document), copied as an asset. */
export function file(
  options?: FileOptions & { readonly allowRemote?: false },
): z.ZodType<AnhurFile>;
export function file(
  options: FileOptions & { readonly allowRemote: true },
): z.ZodType<AnhurFile | RemoteImage>;
export function file(
  options: FileOptions = {},
): z.ZodType<AnhurFile | RemoteImage> {
  const allowRemote = options.allowRemote === true;
  const output = allowRemote
    ? z.union([AnhurFileSchema, RemoteImageSchema])
    : AnhurFileSchema;
  return defineField(output, {
    kind: "file",
    requires: ASSETS_PLUGIN,
    whenAbsent: "skip",
    compile: async (input, context) => {
      const link = await resolveLocal(
        input,
        context,
        "media",
        allowRemote,
        "a.file()",
      );
      if (!("kind" in link)) return link;
      const result: AnhurFile = {
        src: link.url,
        size: link.asset.size,
        contentType: link.asset.contentType,
      };
      return result;
    },
  });
}

/**
 * Asset field helpers. Import as `import { schema as a } from "@anhur/assets"`.
 *
 * - `a.image()` — local image with size and blur placeholder
 * - `a.file()` — any allowed local file (PDF, audio, video, …)
 */
export const schema = {
  image,
  file,
};
