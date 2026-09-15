import { createJiti } from "jiti";
import { realpath } from "node:fs/promises";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { AnhurConfig } from "../config";
import { ConfigInvalidError, ConfigNotFoundError } from "../errors";

export type LoadConfigResult = {
  config: AnhurConfig;
  configPath: string;
  rootDir: string;
};

export type LoadConfigError =
  | ConfigNotFoundError
  | ConfigInvalidError
  | PlatformError;

export function resolveConfigPath(
  rootDir: string,
  configPath = "anhur.config.ts",
  path: {
    readonly isAbsolute: (p: string) => boolean;
    readonly resolve: (...parts: string[]) => string;
  },
): string {
  return path.isAbsolute(configPath)
    ? configPath
    : path.resolve(rootDir, configPath);
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return filePath;
  }
}

/**
 * Loads `anhur.config.ts` (via jiti) using Effect `FileSystem` + `Path`.
 */
export class ConfigLoader extends Context.Service<
  ConfigLoader,
  {
    readonly resolvePath: (
      rootDir: string,
      configPath?: string,
    ) => Effect.Effect<string>;
    readonly load: (
      rootDir: string,
      configPath?: string,
    ) => Effect.Effect<LoadConfigResult, LoadConfigError>;
  }
>()("@anhur/core/ConfigLoader") {
  static get layer(): Layer.Layer<
    ConfigLoader,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    return createConfigLoaderLayer();
  }
}

function createConfigLoaderLayer(): Layer.Layer<
  ConfigLoader,
  never,
  FileSystem.FileSystem | Path.Path
> {
  return Layer.effect(
    ConfigLoader,
    Effect.fn("makeConfigLoader")(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const jiti = createJiti(import.meta.url, {
        interopDefault: true,
        // Cache within this jiti instance only (not shared with the Vite/CLI host).
        // Config files are cache-busted on each load below.
        moduleCache: true,
        fsCache: false,
        // Prefer Node-native loads for published `node_modules/@anhur/*` installs.
        // Workspace realpaths (packages/*/src) often bypass this match — any
        // process-wide state must still use globalThis / Symbol.for.
        nativeModules: [
          "@anhur/core",
          "@anhur/mdx",
          "@anhur/markdown",
          "@anhur/assets",
          "@anhur/orama",
        ],
      });

      const resolvePath = (rootDir: string, configPath = "anhur.config.ts") =>
        Effect.succeed(resolveConfigPath(rootDir, configPath, path));

      const load = Effect.fn("load")(function* (
        rootDir: string,
        configPath = "anhur.config.ts",
      ) {
        const resolvedConfigPath = resolveConfigPath(rootDir, configPath, path);
        const exists = yield* fs.exists(resolvedConfigPath);

        if (!exists) {
          return yield* Effect.fail(
            new ConfigNotFoundError({ path: resolvedConfigPath }),
          );
        }

        const absoluteConfigPath = yield* Effect.tryPromise({
          try: () => canonicalPath(resolvedConfigPath),
          catch: (cause) =>
            new ConfigInvalidError({
              path: resolvedConfigPath,
              detail: String(cause),
            }),
        });

        // Drop every previously evaluated user module so `cms/collections/*`
        // and other config imports are re-read on watch/Vite rebuilds.
        const cache = jiti.cache;
        if (cache instanceof Map) {
          cache.clear();
        } else if (cache) {
          for (const key of Object.keys(cache)) {
            delete cache[key];
          }
        }

        const mod = yield* Effect.tryPromise({
          try: () =>
            // SAFETY: jiti.import evaluates the user config module; we only read `default`.
            jiti.import(absoluteConfigPath) as Promise<{
              default?: AnhurConfig;
            }>,
          catch: (cause) =>
            new ConfigInvalidError({
              path: absoluteConfigPath,
              detail: `Failed to import config: ${String(cause)}`,
            }),
        });

        const config = mod.default;
        if (!config?.content) {
          return yield* Effect.fail(
            new ConfigInvalidError({
              path: absoluteConfigPath,
              detail:
                "Config must default-export defineConfig({ content: [...] }).",
            }),
          );
        }

        return {
          config,
          configPath: absoluteConfigPath,
          rootDir,
        };
      });

      return ConfigLoader.of({ resolvePath, load });
    })(),
  );
}
