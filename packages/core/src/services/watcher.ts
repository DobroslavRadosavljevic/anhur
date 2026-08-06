import { Context, Effect, Fiber, FileSystem, Layer, Stream } from "effect";
import { formatAnhurError } from "../errors";
import { collectWatchPaths } from "../watch-paths";
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

      const runBuild = (
        options: BuildOptions,
        handlers: WatchHandlers,
      ): Effect.Effect<void> =>
        builder.build(options).pipe(
          Effect.flatMap((result) =>
            Effect.tryPromise({
              try: async () => {
                await handlers.onBuild?.(result);
              },
              catch: (cause) => cause,
            }).pipe(Effect.catch(() => Effect.void)),
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
        );

      const start = (
        options: WatchOptions = {},
        handlers: WatchHandlers = {},
      ): Effect.Effect<WatchController> =>
        Effect.gen(function* () {
          const rootDir = options.rootDir ?? process.cwd();
          const configPath = options.configPath ?? "anhur.config.ts";
          const immediate = options.immediate ?? true;
          const buildOptions = { rootDir, configPath };

          if (immediate) {
            yield* runBuild(buildOptions, handlers);
          }

          const loaded = yield* configLoader.load(rootDir, configPath).pipe(
            Effect.catch((error) => {
              handlers.onError?.(new Error(formatAnhurError(error)));
              return Effect.succeed(null);
            }),
          );

          if (!loaded) {
            return {
              close: async () => undefined,
            };
          }

          const { config, configPath: absoluteConfig } = loaded;
          const watchPaths = collectWatchPaths(config, rootDir, absoluteConfig);

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
              Stream.runForEach(() => runBuild(buildOptions, handlers)),
            ),
          );

          return {
            close: async () => {
              await Effect.runPromise(Fiber.interrupt(fiber));
            },
          };
        });

      return Watcher.of({ start });
    }),
  );
}
