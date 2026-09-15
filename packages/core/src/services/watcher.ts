import {
  Context,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Semaphore,
  Stream,
} from "effect";
import path from "node:path";
import { formatAnhurError } from "../errors";
import {
  canonicalizePath,
  collectWatchPaths,
  isUnderWatchPath,
} from "../watch-paths";
import { Builder, type BuildOptions, type BuildResult } from "./builder";
import { ConfigLoader } from "./config-loader";

export type WatchHandlers = {
  onBuild?: (result: BuildResult) => void | Promise<void>;
  onError?: (error: unknown) => void;
};

export type WatchController = {
  close: () => Promise<void>;
};

export type WatchOptions = BuildOptions & {
  /** Run an initial build when watch starts (default true). */
  immediate?: boolean;
};

/**
 * Watches content + config with `FileSystem.watch` streams and rebuilds.
 */
export class Watcher extends Context.Service<
  Watcher,
  {
    readonly start: (
      options?: WatchOptions,
      handlers?: WatchHandlers,
    ) => Effect.Effect<WatchController>;
  }
>()("@anhur/core/Watcher") {
  static readonly layer: Layer.Layer<
    Watcher,
    never,
    Builder | ConfigLoader | FileSystem.FileSystem
  > = Layer.effect(
    Watcher,
    Effect.gen(function* () {
      const builder = yield* Builder;
      const configLoader = yield* ConfigLoader;
      const fs = yield* FileSystem.FileSystem;

      const start = (
        options: WatchOptions = {},
        handlers: WatchHandlers = {},
      ): Effect.Effect<WatchController> =>
        Effect.gen(function* () {
          const rootDir = options.rootDir ?? process.cwd();
          const configPath = options.configPath ?? "anhur.config.ts";
          const immediate = options.immediate ?? true;
          const buildOptions: BuildOptions = {
            rootDir,
            configPath,
            publicPathPrefix: options.publicPathPrefix,
          };

          const extraFibers: Array<Parameters<typeof Fiber.interrupt>[0]> = [];
          const extraWatched = new Set<string>();
          let contentWatchRoots: string[] = [];
          const rebuildLock = Semaphore.makeUnsafe(1);

          let runBuild: () => Effect.Effect<void> = () => Effect.void;

          const watchExtraSourcePaths = (
            sources: readonly string[],
          ): Effect.Effect<void> =>
            Effect.gen(function* () {
              for (const source of sources) {
                const file = canonicalizePath(source);
                if (
                  contentWatchRoots.some((root) => isUnderWatchPath(file, root))
                ) {
                  continue;
                }
                const parent = path.dirname(file);
                const watchPath =
                  parent === path.parse(parent).root
                    ? file
                    : canonicalizePath(parent);
                if (extraWatched.has(watchPath)) continue;
                extraWatched.add(watchPath);
                const fiber = yield* Effect.forkDetach(
                  fs.watch(watchPath).pipe(
                    Stream.catch(() => Stream.empty),
                    Stream.debounce("50 millis"),
                    Stream.runForEach(() => runBuild()),
                  ),
                );
                extraFibers.push(fiber);
              }
            });

          runBuild = (): Effect.Effect<void> =>
            Semaphore.withPermit(
              rebuildLock,
              builder.build(buildOptions).pipe(
                Effect.tap((result) =>
                  watchExtraSourcePaths(result.emittedAssetSources).pipe(
                    Effect.flatMap(() =>
                      Effect.tryPromise({
                        try: async () => {
                          await handlers.onBuild?.(result);
                        },
                        catch: (cause) => cause,
                      }).pipe(Effect.catch(() => Effect.void)),
                    ),
                  ),
                ),
                Effect.catch((error) =>
                  Effect.sync(() => {
                    handlers.onError?.(
                      error instanceof Error
                        ? error
                        : new Error(formatAnhurError(error)),
                    );
                  }),
                ),
              ),
            );

          const loaded = yield* configLoader.load(rootDir, configPath).pipe(
            Effect.catch((error) => {
              handlers.onError?.(new Error(formatAnhurError(error)));
              return Effect.succeed(null);
            }),
          );

          const absoluteConfig = loaded
            ? loaded.configPath
            : yield* configLoader.resolvePath(rootDir, configPath);
          const watchPaths = loaded
            ? collectWatchPaths(loaded.config, rootDir, loaded.configPath)
            : [
                canonicalizePath(absoluteConfig),
                canonicalizePath(
                  path.join(path.dirname(absoluteConfig), "cms"),
                ),
              ];
          contentWatchRoots = watchPaths;

          if (immediate) {
            yield* runBuild();
          }

          const streams = watchPaths.map((watchPath) =>
            fs.watch(watchPath).pipe(Stream.catch(() => Stream.empty)),
          );

          const merged =
            streams.length === 0
              ? Stream.empty
              : streams.length === 1
                ? streams[0]!
                : Stream.mergeAll(streams, { concurrency: "unbounded" });

          const fiber = yield* Effect.forkDetach(
            merged.pipe(
              Stream.debounce("50 millis"),
              Stream.runForEach(() => runBuild()),
            ),
          );

          return {
            close: async () => {
              await Effect.runPromise(
                Fiber.interruptAll([fiber, ...extraFibers]),
              );
            },
          };
        });

      return Watcher.of({ start });
    }),
  );
}
