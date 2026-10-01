import path from "node:path";
import {
  isRemoteUrl,
  type AnhurPlugin,
  type PluginPublishContext,
  type PluginSetupContext,
} from "@anhur/core/plugin";
import { checkConcurrency, copyAssets, pruneAssets } from "./copy";
import {
  normalizePrefix,
  pruneStorage,
  syncStorage,
  type AssetsStorageOptions,
} from "./storage";
import { svgTransformVersion, type SvgMode } from "./svg";

/** Plugin name; `a.image()` / `a.file()` and relative body links require it. */
export const ASSETS_PLUGIN = "assets";

/**
 * Extensions copied by default: images, audio, video, captions, fonts and
 * PDF. Data and office formats (which may hold private data, like a stray
 * `../service-account.json`) are opt-in: see
 * {@link DOCUMENT_ASSET_EXTENSIONS}.
 */
export const DEFAULT_ASSET_EXTENSIONS: readonly string[] = [
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".weba",
  ".m4v",
  ".mov",
  ".mp4",
  ".ogv",
  ".webm",
  ".vtt",
  ".otf",
  ".ttf",
  ".woff",
  ".woff2",
  ".pdf",
];

/**
 * Data, archive and office formats. Add them on purpose:
 * `assets({ extensions: [...DEFAULT_ASSET_EXTENSIONS, ".zip"] })`.
 */
export const DOCUMENT_ASSET_EXTENSIONS: readonly string[] = [
  ".csv",
  ".doc",
  ".docx",
  ".epub",
  ".gz",
  ".json",
  ".ppt",
  ".pptx",
  ".txt",
  ".xls",
  ".xlsx",
  ".zip",
];

export type AssetsOptions = {
  /** Folder for copied files, relative to the config file. Default `.anhur/assets`. */
  readonly dir?: string;
  /**
   * Public URL prefix of copied files. Default `/anhur-assets/`. A full URL
   * (CDN) is used as is.
   */
  readonly base?: string;
  /**
   * URL prefix used in dev mode. Default: `/anhur-assets/` when `base` is a
   * CDN that is only filled by builds (`storage` without `syncInDev`).
   */
  readonly devBase?: string;
  /**
   * Extra folders (relative to the config file) assets may come from, for
   * example a shared `images` folder outside the project or a package in
   * `node_modules`. Default: the project folder only. Dotfiles, dot-folders
   * and `node_modules` below a root are always refused.
   */
  readonly roots?: readonly string[];
  /** Allowed file extensions (with dot). Default {@link DEFAULT_ASSET_EXTENSIONS}. */
  readonly extensions?: readonly string[];
  /**
   * `sanitize` (default) rebuilds copied SVGs from an allowlist of SVG
   * elements and attributes (no scripts, event handlers, foreign content or
   * `javascript:` links) and rejects malformed SVGs; `keep` copies them as
   * is. The mode is part of SVG output names.
   */
  readonly svg?: SvgMode;
  /** Upload copied files to S3-compatible storage (files-sdk). Omit to keep files local. */
  readonly storage?: AssetsStorageOptions;
};

export type AssetsPlugin = AnhurPlugin & {
  readonly name: typeof ASSETS_PLUGIN;
  readonly assetsOptions: AssetsOptions;
};

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/** A remote base (`https://…` or `//…`) as a URL, or `undefined` when invalid. */
function remoteBaseUrl(base: string): URL | undefined {
  const value = base.trim();
  try {
    return new URL(value.startsWith("//") ? `https:${value}` : value);
  } catch {
    return undefined;
  }
}

/** Problem with an assets base URL, or `undefined` when it is usable. */
function baseProblem(base: string): string | undefined {
  const value = base.trim();
  if (isRemoteUrl(value)) {
    const url = remoteBaseUrl(value);
    if (!url) return "is not a valid URL";
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "must be an http(s) URL";
    }
    if (url.hostname === "") return "has no host";
    if (url.search !== "" || url.hash !== "") {
      return "must not have a ?query or #hash";
    }
    return undefined;
  }
  if (/[?#\\]/.test(value)) return "must not contain ?, # or \\";
  const segments = value.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) {
    return "must not be the site root; use a dedicated prefix such as /anhur-assets/";
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return 'must not contain "." or ".." segments';
  }
  return undefined;
}

function checkSetup(
  options: AssetsOptions,
  dir: string,
  base: string,
  context: PluginSetupContext,
): void {
  const absolute = path.resolve(context.projectDir, dir);
  if (isInside(context.projectDir, absolute)) {
    context.error(
      `dir "${dir}" is the project folder or a parent of it.`,
      'Use a dedicated folder such as ".anhur/assets".',
    );
  }
  if (
    isInside(absolute, context.outputDir) ||
    isInside(context.outputDir, absolute)
  ) {
    context.error(
      `dir "${dir}" overlaps outputDir.`,
      "Keep assets and generated modules in separate folders.",
    );
  }
  for (const root of context.contentRoots) {
    if (isInside(root, absolute) || isInside(absolute, root)) {
      context.error(
        `dir "${dir}" overlaps a content folder (${root}).`,
        "Point assets({ dir }) at a dedicated folder.",
      );
    }
  }
  for (const [name, value] of [
    ["base", base],
    ["devBase", options.devBase],
  ] as const) {
    if (value === undefined) continue;
    const problem = baseProblem(value);
    if (problem) context.error(`${name} "${value}" ${problem}.`);
  }
  for (const extension of options.extensions ?? []) {
    if (!/^\.[a-z0-9]+$/i.test(extension)) {
      context.error(`extension "${extension}" must look like ".png".`);
    }
  }
  if (
    options.svg !== undefined &&
    options.svg !== "sanitize" &&
    options.svg !== "keep"
  ) {
    context.error(
      `svg must be "sanitize" or "keep" (got "${String(options.svg)}").`,
    );
  }
  const storage = options.storage;
  if (!storage) return;
  try {
    checkConcurrency(storage.concurrency);
  } catch (cause) {
    context.error(
      `storage.${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const prefix = normalizePrefix(storage.prefix);
  if (prefix === "") {
    context.error('storage.prefix must not be empty (for example "site").');
  }
  if (!isRemoteUrl(base)) {
    context.error(
      `storage needs base to be the public URL of the bucket prefix (got "${base}").`,
      `For example base: "https://cdn.example.com/${prefix}".`,
    );
    return;
  }
  const url = remoteBaseUrl(base);
  if (!url || baseProblem(base) !== undefined) return;
  const normalized = url.pathname.endsWith("/")
    ? url.pathname
    : `${url.pathname}/`;
  if (prefix !== "" && !normalized.endsWith(`/${prefix}`)) {
    context.error(
      `base "${base}" does not end with the storage prefix "${prefix}", so generated URLs would not match uploaded keys.`,
    );
  }
}

/**
 * Copy files referenced by documents (`a.image()`, `a.file()`, relative
 * links in Markdown / MDX bodies) into a content-hashed assets folder, and
 * optionally upload them to a CDN.
 *
 * Files are only read from the project folder (and `roots`); dotfiles,
 * `node_modules` and unlisted extensions are refused. Copies and uploads
 * happen before generated modules are published; files of earlier builds
 * are pruned after them. Uploads run in `build` mode only unless
 * `syncInDev`; storage pruning runs in `build` mode only.
 */
export function assets(options: AssetsOptions = {}): AssetsPlugin {
  const dir = options.dir ?? ".anhur/assets";
  const base = options.base ?? "/anhur-assets/";
  const svg = options.svg ?? "sanitize";
  const storage = options.storage;
  const devBase =
    options.devBase ??
    (storage && !storage.syncInDev && isRemoteUrl(base)
      ? "/anhur-assets/"
      : undefined);
  const extensions = (options.extensions ?? DEFAULT_ASSET_EXTENSIONS).map(
    (extension) => extension.toLowerCase(),
  );
  /** Storage keys this process uploaded or saw, so rebuilds skip `exists()`. */
  const stored = new Set<string>();
  return {
    name: ASSETS_PLUGIN,
    version: "3",
    assetsOptions: options,
    assets: {
      base,
      devBase,
      dir,
      roots: options.roots,
      extensions,
      transformVersion: (extension) => svgTransformVersion(extension, svg),
    },
    setup: (context) => {
      checkSetup(options, dir, base, context);
    },
    beforePublish: async (context: PluginPublishContext) => {
      if (!context.assetsDir) return;
      const copied = await copyAssets(context.assetsDir, context.assets, {
        svg,
        extensions,
      });
      if (copied.copied > 0) {
        context.info(
          `assets: ${copied.copied} copied (${context.assets.length} in use)`,
        );
      }
      if (storage && (context.mode === "build" || storage.syncInDev === true)) {
        const result = await syncStorage(
          storage,
          context.assetsDir,
          context.assets,
          stored,
        );
        if (result.uploaded > 0 || context.mode === "build") {
          context.info(
            `assets storage: ${result.uploaded} uploaded, ${result.skipped} already stored${result.dryRun ? " (dry run)" : ""}`,
          );
        }
      }
    },
    afterPublish: async (context: PluginPublishContext) => {
      if (!context.assetsDir) return;
      const pruned = await pruneAssets(context.assetsDir, context.assets, {
        extensions,
      });
      if (pruned.removed > 0) {
        context.info(`assets: ${pruned.removed} unused file(s) removed`);
      }
      if (storage?.prune === true && context.mode === "build") {
        const result = await pruneStorage(storage, context.assets, stored);
        context.info(
          `assets storage: ${result.deleted} unused object(s) deleted${result.dryRun ? " (dry run)" : ""}`,
        );
      }
    },
  };
}
