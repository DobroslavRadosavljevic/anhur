import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { AnhurConfig } from "./config";
import { createPersistCache, type PersistCache } from "./persist-cache";
import { findProcessor, type ProcessorPlugin } from "./processors";

/** Well-known id for `@anhur/assets` `assets()` processor. */
export const ASSETS_PROCESSOR_ID = "assets";

export type AssetsProcessorOptions = {
  /** Directory for copied assets, relative to config file. Default `.anhur/assets`. */
  dir?: string;
  /** Public URL prefix (trailing slash). Default `/anhur-assets/`. */
  base?: string;
};

export type ResolvedAssetsConfig = {
  /** Absolute directory for copied files. */
  dir: string;
  /** Public URL prefix ending with `/`. */
  base: string;
};

export type EmittedAsset = {
  /** Public URL under `base`. */
  src: string;
  /** Absolute path of the copied file. */
  outputPath: string;
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
};

const GLOBAL_KEY = "__anhur_build_context_als__" as const;

type GlobalAls = typeof globalThis & {
  [GLOBAL_KEY]?: AsyncLocalStorage<BuildContext>;
};

function getStorage(): AsyncLocalStorage<BuildContext> {
  const g = globalThis as GlobalAls;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new AsyncLocalStorage<BuildContext>();
  }
  return g[GLOBAL_KEY];
}

function normalizeBase(base: string): string {
  if (!base.endsWith("/")) return `${base}/`;
  return base;
}

export function resolveAssetsConfig(
  config: AnhurConfig,
  configDir: string,
): ResolvedAssetsConfig | undefined {
  const plugin = findProcessor(config.processors, ASSETS_PROCESSOR_ID);
  if (!plugin) return undefined;
  const options = (plugin.options ?? {}) as AssetsProcessorOptions;
  const dir = path.resolve(configDir, options.dir ?? ".anhur/assets");
  const base = normalizeBase(options.base ?? "/anhur-assets/");
  return { dir, base };
}

export type CreateBuildContextOptions = {
  rootDir: string;
  configDir: string;
};

export async function createBuildContext(
  config: AnhurConfig,
  options: CreateBuildContextOptions,
): Promise<BuildContext> {
  const processors = config.processors ?? [];
  const cache = new Map<string, string>();
  const assets = resolveAssetsConfig(config, options.configDir);

  const persistCache =
    config.cacheDir === false
      ? undefined
      : await createPersistCache(
          path.resolve(options.configDir, config.cacheDir ?? ".anhur/cache"),
        );

  if (assets) {
    await rm(assets.dir, { recursive: true, force: true });
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
      };
      emitCache.set(resolved, emitted);
      return emitted;
    },
  };
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
