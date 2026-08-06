import { Context, Effect, Layer, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { rm } from "node:fs/promises";
import { applyDocumentTransforms } from "../apply-transforms";
import { syncEmittedAssetsStorage } from "../assets-storage";
import type { AssetsStorageSyncResult } from "../assets-storage";
import { createBuildContext, pruneEmittedAssets } from "../build-context";
import { isCollection, isSingleton, type AnhurConfig } from "../config";
import {
  ConfigInvalidError,
  ReferenceFailedError,
  type TransformFailedError,
} from "../errors";
import { runIntegrations } from "../integrations";
import { publishStagingDirectory, stagingDirectoryFor } from "../publish-dir";
import { resolvePendingReferences } from "../relations";
import { toBuiltSnapshots } from "../transform";
import { ConfigLoader, type LoadConfigError } from "./config-loader";
import {
  ContentCollector,
  type CollectError,
  type CollectedDocument,
} from "./content-collector";
import { Generator, type BuiltSource } from "./generator";

export type BuildOptions = {
  /** Project root (directory that contains content + config). */
  rootDir?: string;
  /** Path to config file, absolute or relative to rootDir. */
  configPath?: string;
};

export type BuildResult = {
  config: AnhurConfig;
  configPath: string;
  outputDir: string;
  built: BuiltSource[];
  /** Present when `assets({ storage: { enabled: true } })` ran. */
  assetsStorage?: AssetsStorageSyncResult;
};

export type BuildError =
  | LoadConfigError
  | CollectError
  | ReferenceFailedError
  | TransformFailedError
  | PlatformError;

/**
 * Orchestrates load → collect → refs → transform → prepare → generate → hooks.
 */
export class Builder extends Context.Service<
  Builder,
  {
    readonly build: (
      options?: BuildOptions,
    ) => Effect.Effect<BuildResult, BuildError>;
  }
>()("@anhur/core/Builder") {
  static readonly layer: Layer.Layer<
    Builder,
    never,
    ConfigLoader | ContentCollector | Generator | Path.Path
  > = Layer.effect(
    Builder,
    Effect.gen(function* () {
      const configLoader = yield* ConfigLoader;
      const collector = yield* ContentCollector;
      const generator = yield* Generator;
      const path = yield* Path.Path;

      const build = (
        options: BuildOptions = {},
      ): Effect.Effect<BuildResult, BuildError> =>
        Effect.gen(function* () {
          const rootDir = options.rootDir ?? process.cwd();
          const { config, configPath } = yield* configLoader.load(
            rootDir,
            options.configPath ?? "anhur.config.ts",
          );

          const configDir = path.dirname(configPath);
          const outputDir = path.resolve(
            configDir,
            config.outputDir ?? ".anhur/generated",
          );
          // Write into a sibling staging dir, then swap only after integrations
          // and hooks succeed — so a failed rebuild cannot wipe live Orama /
          // generated modules that Vite is still serving.
          const stagingOutputDir = stagingDirectoryFor(outputDir);

          const buildContext = yield* Effect.tryPromise({
            try: () =>
              createBuildContext(config, {
                rootDir,
                configDir,
              }),
            catch: (cause) =>
              new ConfigInvalidError({
                path: configPath,
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
          });
          const built: BuiltSource[] = [];

          for (const source of config.content) {
            if (isCollection(source)) {
              const documents = yield* collector.collectCollection(
                source,
                rootDir,
                config,
                buildContext,
              );
              built.push({ source, documents });
            } else if (isSingleton(source)) {
              const documents = yield* collector.collectSingleton(
                source,
                rootDir,
                config,
                buildContext,
              );
              built.push({ source, documents });
            }
          }

          const refFailures = resolvePendingReferences(built);
          if (refFailures.length > 0) {
            const first = refFailures[0]!;
            return yield* Effect.fail(
              new ReferenceFailedError({
                filePath: first.filePath,
                fieldPath: first.fieldPath,
                detail:
                  refFailures.length === 1
                    ? first.detail
                    : `${first.detail} (and ${refFailures.length - 1} more)`,
              }),
            );
          }

          yield* applyDocumentTransforms(built);

          if (config.prepare) {
            const prepareSnapshots = toBuiltSnapshots(built);
            const prepare = config.prepare;
            yield* Effect.tryPromise({
              try: async () => {
                await prepare(prepareSnapshots);
              },
              catch: (cause) =>
                new ConfigInvalidError({
                  path: configPath,
                  detail: `prepare hook failed: ${
                    cause instanceof Error ? cause.message : String(cause)
                  }`,
                }),
            });
            // Sync prepare mutations back into collector documents for codegen.
            for (const snap of prepareSnapshots) {
              const item = built.find((b) => b.source.name === snap.name);
              if (!item) continue;
              item.documents = snap.documents.map((doc) => {
                const { _meta, ...data } = doc;
                return {
                  data: data as Record<string, unknown>,
                  _meta,
                };
              });
            }
          }

          const removeStaging = Effect.promise(() =>
            rm(stagingOutputDir, { recursive: true, force: true }),
          ).pipe(Effect.catch(() => Effect.void));

          const writeAndPublish = Effect.gen(function* () {
            yield* removeStaging;

            yield* generator.write({
              config,
              configPath,
              rootDir,
              outputDir: stagingOutputDir,
              built,
            });

            const snapshots = toBuiltSnapshots(built);
            for (const item of built) {
              const snap = snapshots.find((s) => s.name === item.source.name);
              if (!snap) continue;
              const source = item.source;
              if (isCollection(source) && source.onSuccess) {
                const onSuccess = source.onSuccess;
                yield* Effect.tryPromise({
                  try: async () => {
                    await onSuccess(snap.documents);
                  },
                  catch: (cause) =>
                    new ConfigInvalidError({
                      path: configPath,
                      detail: `onSuccess(${source.name}) failed: ${
                        cause instanceof Error ? cause.message : String(cause)
                      }`,
                    }),
                });
              }
              if (isSingleton(source) && source.onSuccess) {
                const onSuccess = source.onSuccess;
                yield* Effect.tryPromise({
                  try: async () => {
                    await onSuccess(snap.documents[0]);
                  },
                  catch: (cause) =>
                    new ConfigInvalidError({
                      path: configPath,
                      detail: `onSuccess(${source.name}) failed: ${
                        cause instanceof Error ? cause.message : String(cause)
                      }`,
                    }),
                });
              }
            }

            if (config.integrations?.length) {
              const integrations = config.integrations;
              yield* Effect.tryPromise({
                try: async () => {
                  await runIntegrations(integrations, {
                    rootDir,
                    outputDir: stagingOutputDir,
                    sources: snapshots,
                    config,
                  });
                },
                catch: (cause) =>
                  new ConfigInvalidError({
                    path: configPath,
                    detail: `integrations failed: ${
                      cause instanceof Error ? cause.message : String(cause)
                    }`,
                  }),
              });
            }

            if (config.complete) {
              const complete = config.complete;
              yield* Effect.tryPromise({
                try: async () => {
                  await complete(snapshots, {
                    rootDir,
                    outputDir: stagingOutputDir,
                  });
                },
                catch: (cause) =>
                  new ConfigInvalidError({
                    path: configPath,
                    detail: `complete hook failed: ${
                      cause instanceof Error ? cause.message : String(cause)
                    }`,
                  }),
              });
            }

            yield* Effect.tryPromise({
              try: () => publishStagingDirectory(stagingOutputDir, outputDir),
              catch: (cause) =>
                new ConfigInvalidError({
                  path: configPath,
                  detail: `failed to publish generated output: ${
                    cause instanceof Error ? cause.message : String(cause)
                  }`,
                }),
            });

            const assetsStorage = yield* Effect.tryPromise({
              try: () => syncEmittedAssetsStorage(buildContext),
              catch: (cause) =>
                new ConfigInvalidError({
                  path: configPath,
                  detail: `failed to sync asset storage: ${
                    cause instanceof Error ? cause.message : String(cause)
                  }`,
                }),
            });

            yield* Effect.tryPromise({
              try: () => pruneEmittedAssets(buildContext),
              catch: (cause) =>
                new ConfigInvalidError({
                  path: configPath,
                  detail: `failed to prune assets: ${
                    cause instanceof Error ? cause.message : String(cause)
                  }`,
                }),
            });

            return {
              config,
              configPath,
              outputDir,
              built,
              ...(assetsStorage ? { assetsStorage } : {}),
            };
          });

          return yield* writeAndPublish.pipe(
            Effect.onError(() => removeStaging),
          );
        });

      return Builder.of({ build });
    }),
  );
}

export type { BuiltSource, CollectedDocument };
