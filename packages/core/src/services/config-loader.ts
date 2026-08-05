import { createJiti } from "jiti";
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
  static readonly layer: Layer.Layer<
    ConfigLoader,
    never,
    FileSystem.FileSystem | Path.Path
  > = Layer.effect(
    ConfigLoader,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const jiti = createJiti(import.meta.url, {
        interopDefault: true,
        // Keep moduleCache so `@anhur/*` helpers share process state with the host
        // (document meta / build context). Config files themselves still re-import
        // when the absolute path changes.
        moduleCache: true,
        fsCache: false,
        nativeModules: [
          "@anhur/core",
          "@anhur/mdx",
          "@anhur/markdown",
          "@anhur/assets",
        ],
      });

      const resolvePath = (
        rootDir: string,
        configPath = "anhur.config.ts",
      ) => Effect.succeed(resolveConfigPath(rootDir, configPath, path));

      const load = (
        rootDir: string,
        configPath = "anhur.config.ts",
      ): Effect.Effect<LoadConfigResult, LoadConfigError> =>
        Effect.gen(function* () {
          const absoluteConfigPath = resolveConfigPath(
            rootDir,
            configPath,
            path,
          );
          const exists = yield* fs.exists(absoluteConfigPath);

          if (!exists) {
            return yield* Effect.fail(
              new ConfigNotFoundError({ path: absoluteConfigPath }),
            );
          }

          const mod = yield* Effect.tryPromise({
            try: () =>
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
    }),
  );
}
