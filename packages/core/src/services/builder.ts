import { Context, Effect, Layer, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { rm } from "node:fs/promises";
import { applyDocumentTransforms } from "../apply-transforms";
import { syncEmittedAssetsStorage } from "../assets-storage";
import type { AssetsStorageSyncResult } from "../assets-storage";
import {
  createBuildContext,
  pruneEmittedAssets,
  type ResolvedAssetsConfig,
} from "../build-context";
import { isCollection, isSingleton, type AnhurConfig } from "../config";
import { isDocumentFields } from "../document-fields";
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
import { ContentCollector, type CollectError } from "./content-collector";
import { Generator, type BuiltSource } from "./generator";

export type BuildOptions = {
  /** Project root (directory that contains content + config). */
  rootDir?: string;
  /** Path to config file, absolute or relative to rootDir. */
  configPath?: string;
  /**
   * Host app public URL prefix (Vite `resolved.base`). Joined with
   * `assets({ base })` for generated asset `src` values. CLI builds omit this.
   */
  publicPathPrefix?: string;
};

export type BuildResult = {
  config: AnhurConfig;
  configPath: string;
  outputDir: string;
  built: BuiltSource[];
  /** Present when an `assets()` processor is registered. */
  assets?: ResolvedAssetsConfig;
  /** Absolute source files copied via `emitAsset` (watch roots outside content). */
  emittedAssetSources: readonly string[];
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
  static get layer(): Layer.Layer<
    Builder,
    never,
    ConfigLoader | ContentCollector | Generator | Path.Path
  > {
    return createBuilderLayer();
  }
}

function createBuilderLayer(): Layer.Layer<
  Builder,
  never,
  ConfigLoader | ContentCollector | Generator | Path.Path
> {
  return Layer.effect(
    Builder,
    Effect.fn("makeBuilder")(function* () {
      const configLoader = yield* ConfigLoader;
      const collector = yield* ContentCollector;
      const generator = yield* Generator;
      const path = yield* Path.Path;

      const build = Effect.fn("build")(function* (options: BuildOptions = {}) {
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
              publicPathPrefix: options.publicPathPrefix,
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

        // Drop frontmatter drafts before relations so they neither occupy
        // unique slots (handled in `s.unique()`) nor become embed targets.
        for (const item of built) {
          item.documents = item.documents.filter(
            (doc) => doc.data.draft !== true,
          );
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
              if (!isDocumentFields(data)) {
                return { data: {}, _meta };
              }
              return { data, _meta };
            });
          }
        }

        const removeStaging = Effect.tryPromise({
          try: () => rm(stagingOutputDir, { recursive: true, force: true }),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.void));

        const writeAndPublish = Effect.fn("writeAndPublish")(function* () {
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

          const result: BuildResult = {
            config,
            configPath,
            outputDir,
            built,
            emittedAssetSources: buildContext.getEmittedAssetSources(),
          };
          if (buildContext.assets) {
            result.assets = buildContext.assets;
          }
          if (assetsStorage) {
            result.assetsStorage = assetsStorage;
          }
          return result;
        });

        return yield* writeAndPublish().pipe(
          Effect.onError(() => removeStaging),
        );
      });

      return Builder.of({ build });
    })(),
  );
}
