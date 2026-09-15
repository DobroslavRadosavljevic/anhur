import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { resolvePublicAndLocalAssetBases } from "./asset-urls";
import type { AnhurConfig } from "./config";
import { createPersistCache, type PersistCache } from "./persist-cache";
import { findProcessor, type ProcessorPlugin } from "./processors";

/** Well-known id for `@anhur/assets` `assets()` processor. */
export const ASSETS_PROCESSOR_ID = "assets";

/** files-sdk upload may resolve void or an object with ETag / size. */
export type AssetUploadResult = void | {
  key?: string;
  size?: number;
  contentType?: string;
  etag?: string;
  lastModified?: number;
  skipped?: boolean;
};

/** Minimal files-sdk-compatible client used for upload / exists / list / delete. */
export type AssetStorageClient = {
  upload(
    key: string,
    body: Uint8Array | string,
    opts?: { cacheControl?: string; contentType?: string },
  ): Promise<AssetUploadResult>;
  exists(key: string): Promise<boolean>;
  /**
   * Delete one key or many. files-sdk bulk delete returns
   * `{ deleted, errors? }` and does not throw on partial failure — callers
   * must inspect `errors`.
   */
  delete(key: string | string[]): Promise<void | {
    deleted?: string[];
    errors?: Array<{ key: string; error: Error }>;
  }>;
  listAll(opts?: { prefix?: string }): AsyncIterable<{ key: string }>;
};

/**
 * Duck-typed files-sdk `Files` client (or a factory that returns one).
 * Prefer a factory so disabled builds never construct the provider client.
 */
export type AssetsStorageFilesInput =
  | AssetStorageClient
  | (() => AssetStorageClient | Promise<AssetStorageClient>);

type AssetsStorageSharedOptions = {
  /** Plan uploads/deletes without writing. Default `false`. */
  dryRun?: boolean;
  /** Parallel uploads. Default `8`. */
  concurrency?: number;
  /** Cache-Control for uploads. Default immutable year-long. */
  cacheControl?: string;
  /**
   * Allow prune when this build emitted zero assets (deletes every key under
   * prefix). Default `false` — empty emit skips prune to avoid wiping the CDN.
   */
  pruneEmpty?: boolean;
};

/**
 * Always pass `storage`; gate work with `enabled`.
 * When disabled, `files` / `prefix` are optional so local config need not
 * construct a client.
 */
export type AssetsStorageOptions =
  | (AssetsStorageSharedOptions & {
      enabled: false;
      files?: AssetsStorageFilesInput;
      prefix?: string;
      prune?: boolean;
    })
  | (AssetsStorageSharedOptions & {
      enabled: true;
      /**
       * files-sdk `Files` instance (or factory). Do not set a constructor
       * `prefix` on the client — Anhur applies {@link AssetsStorageOptions}
       * `prefix`.
       */
      files: AssetsStorageFilesInput;
      /**
       * Remote key prefix (required when enabled). Isolates list/delete
       * (e.g. `"anhur"` → keys like `anhur/cover-abc12345.png`).
       */
      prefix: string;
      /** Delete remote keys under prefix that were not emitted. Default `true`. */
      prune?: boolean;
    });

export type AssetsProcessorOptions = {
  /** Directory for copied assets, relative to config file. Default `.anhur/assets`. */
  dir?: string;
  /** Public URL prefix (trailing slash). Default `/anhur-assets/`. */
  base?: string;
  /**
   * Optional remote storage sync (S3-compatible via files-sdk).
   * Always pass the object; gate uploads with {@link AssetsStorageOptions.enabled}.
   */
  storage?: AssetsStorageOptions;
};

export type ResolvedAssetsConfig = {
  /** Absolute directory for copied files. */
  dir: string;
  /**
   * Public URL prefix ending with `/` (generated `src`).
   * Includes the host app public path (Vite `base`) when that was passed in.
   */
  base: string;
  /** `assets({ base })` as configured (trailing slash). Storage checks use this. */
  configuredBase: string;
  /**
   * Origin-absolute path for Vite `outDir` copy and local middleware.
   * `undefined` when configured `base` is a remote URL.
   */
  localBase: string | undefined;
};

export type EmittedAsset = {
  /** Public URL under `base`. */
  src: string;
  /** Absolute path of the copied file. */
  outputPath: string;
  /** Absolute path of the source file passed to `emitAsset`. */
  sourcePath: string;
};

/**
 * Build-scoped context for Zod helpers (unique cache, processors, asset emit).
 */
export type BuildContext = {
  readonly config: AnhurConfig;
  readonly processors: readonly ProcessorPlugin[];
  readonly cache: Map<string, string>;
  /** Disk cache for MDX/Markdown (and other heavy helpers). */
  readonly persistCache: PersistCache | undefined;
  readonly rootDir: string;
  readonly configDir: string;
  readonly assets: ResolvedAssetsConfig | undefined;
  getProcessor(id: string): ProcessorPlugin | undefined;
  /**
   * Copy a source file into the assets directory (content-hashed name)
   * and return its public `src`. Requires an `assets` processor.
   */
  emitAsset(absoluteSourcePath: string): Promise<EmittedAsset>;
  /** Assets copied during this build (for pruning orphans after success). */
  getEmittedAssets(): readonly EmittedAsset[];
  /** Absolute source paths passed to `emitAsset` during this build. */
  getEmittedAssetSources(): readonly string[];
};

const GLOBAL_KEY = "__anhur_build_context_als__" as const;

type GlobalAls = typeof globalThis & {
  [GLOBAL_KEY]?: AsyncLocalStorage<BuildContext>;
};

function getStorage(): AsyncLocalStorage<BuildContext> {
  // SAFETY: preserves the existing runtime contract for this assignment.
  const g = globalThis as GlobalAls;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new AsyncLocalStorage<BuildContext>();
  }
  return g[GLOBAL_KEY];
}

export function resolveAssetsConfig(
  config: AnhurConfig,
  configDir: string,
  publicPathPrefix?: string,
): ResolvedAssetsConfig | undefined {
  const plugin = findProcessor(config.processors, ASSETS_PROCESSOR_ID);
  if (!plugin) return undefined;
  // SAFETY: assets() processor options are validated when the plugin is registered.
  const options = (plugin.options ?? {}) as AssetsProcessorOptions;
  const dir = path.resolve(configDir, options.dir ?? ".anhur/assets");
  const configuredBase = options.base ?? "/anhur-assets/";
  const withoutApp = resolvePublicAndLocalAssetBases(configuredBase);
  const { publicBase, localBase } = resolvePublicAndLocalAssetBases(
    configuredBase,
    publicPathPrefix,
  );
  return {
    dir,
    base: publicBase,
    configuredBase: withoutApp.publicBase,
    localBase,
  };
}

export type CreateBuildContextOptions = {
  rootDir: string;
  configDir: string;
  /**
   * Host app public URL prefix (Vite `resolved.base`). Joined with
   * `assets({ base })` for generated `src` values. Omit for CLI builds.
   */
  publicPathPrefix?: string;
};

export async function createBuildContext(
  config: AnhurConfig,
  options: CreateBuildContextOptions,
): Promise<BuildContext> {
  const processors = config.processors ?? [];
  const cache = new Map<string, string>();
  const assets = resolveAssetsConfig(
    config,
    options.configDir,
    options.publicPathPrefix,
  );

  const persistCache =
    config.cacheDir === false
      ? undefined
      : await createPersistCache(
          path.resolve(options.configDir, config.cacheDir ?? ".anhur/cache"),
        );

  // Do not wipe the live assets directory here. A failed rebuild (invalid
  // content, etc.) must leave the previous successful assets on disk for Vite
  // to keep serving. Orphans are removed via pruneEmittedAssets after success.
  if (assets) {
    await mkdir(assets.dir, { recursive: true });
  }

  const emitCache = new Map<string, EmittedAsset>();

  return {
    config,
    processors,
    cache,
    persistCache,
    rootDir: options.rootDir,
    configDir: options.configDir,
    assets,
    getProcessor(id) {
      return findProcessor(processors, id);
    },
    getEmittedAssets() {
      return [...emitCache.values()];
    },
    getEmittedAssetSources() {
      return [...emitCache.keys()];
    },
    async emitAsset(absoluteSourcePath) {
      if (!assets) {
        throw new Error(
          "emitAsset requires an assets() processor in defineConfig({ processors }).",
        );
      }

      const resolved = path.resolve(absoluteSourcePath);
      const cached = emitCache.get(resolved);
      if (cached) return cached;

      const bytes = await readFile(resolved);
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
      const ext = path.extname(resolved);
      const baseName = path.basename(resolved, ext);
      const fileName = `${baseName}-${hash}${ext}`;
      const outputPath = path.join(assets.dir, fileName);
      await mkdir(assets.dir, { recursive: true });
      await copyFile(resolved, outputPath);

      const emitted: EmittedAsset = {
        src: `${assets.base}${fileName}`,
        outputPath,
        sourcePath: resolved,
      };
      emitCache.set(resolved, emitted);
      return emitted;
    },
  };
}

/**
 * Remove asset files that were not emitted during this successful build.
 * Safe to call only after the build fully succeeds.
 */
export async function pruneEmittedAssets(ctx: BuildContext): Promise<void> {
  if (!ctx.assets) return;

  const keep = new Set(
    ctx.getEmittedAssets().map((asset) => path.resolve(asset.outputPath)),
  );
  const entries = await readdir(ctx.assets.dir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const full = path.join(ctx.assets!.dir, entry.name);
      if (keep.has(path.resolve(full))) return;
      await rm(full, { force: true });
    }),
  );
}

export function getBuildContext(): BuildContext {
  const ctx = getStorage().getStore();
  if (!ctx) {
    throw new Error(
      "Build context is unavailable. Anhur schema helpers only work during content collection.",
    );
  }
  return ctx;
}

export function withBuildContext<T>(
  ctx: BuildContext,
  run: () => Promise<T>,
): Promise<T> {
  return getStorage().run(ctx, run);
}
