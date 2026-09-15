import * as path from "node:path";
import { Console, Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command, Flag } from "effect/unstable/cli";
import { formatAssetsStorageLogLines } from "../assets-storage";
import { buildEffect, type BuildResult } from "../build";
import { formatAnhurError } from "../errors";
import { layer as nodeLiveLayer } from "../layers/node-live";
import { packageVersion } from "../package-version";
import { watchEffect } from "../watch";

const projectFlags = {
  root: Flag.Directory("root", { mustExist: true }).pipe(
    Flag.withDescription("Project root directory"),
    Flag.withDefault("."),
  ),
  config: Flag.String("config").pipe(
    Flag.withDescription(
      "Config path relative to root (default: anhur.config.ts)",
    ),
    Flag.withDefault("anhur.config.ts"),
  ),
};

function countDocuments(result: BuildResult): number {
  return result.built.reduce((n, item) => n + item.documents.length, 0);
}

function logBuildSummary(kind: "built" | "rebuilt", result: BuildResult) {
  return Effect.gen(function* () {
    yield* Console.log(
      `anhur: ${kind} ${countDocuments(result)} document(s) → ${result.outputDir}`,
    );
    if (result.assetsStorage) {
      for (const line of formatAssetsStorageLogLines(result.assetsStorage, {
        prefix: "anhur:   ",
      })) {
        yield* Console.log(line);
      }
    }
  });
}

const build = Command.make("build", projectFlags, (config) =>
  Effect.gen(function* () {
    const rootDir = path.resolve(config.root);
    const result = yield* buildEffect({
      rootDir,
      configPath: config.config,
    }).pipe(Effect.tapError((error) => Console.error(formatAnhurError(error))));
    yield* logBuildSummary("built", result);
  }),
).pipe(Command.withDescription("Collect content and write .anhur/generated"));

const watch = Command.make("watch", projectFlags, (config) =>
  Effect.scoped(
    Effect.gen(function* () {
      const rootDir = path.resolve(config.root);
      yield* Console.log(`anhur: watching ${rootDir} (${config.config})`);

      yield* Effect.acquireRelease(
        watchEffect(
          { rootDir, configPath: config.config },
          {
            onBuild(result) {
              return Effect.runPromise(logBuildSummary("rebuilt", result));
            },
            onError(error) {
              return Effect.runPromise(
                Console.error(
                  `anhur: ${
                    error instanceof Error
                      ? error.message
                      : formatAnhurError(error)
                  }`,
                ),
              );
            },
          },
        ),
        (controller) => Effect.promise(() => controller.close()),
      );

      // Keep the process alive until SIGINT / SIGTERM (NodeRuntime).
      yield* Effect.never;
    }),
  ),
).pipe(Command.withDescription("Rebuild on content or config changes"));

/**
 * Root `anhur` command tree (`build` / `watch`).
 */
export const cli = Command.make("anhur").pipe(
  Command.withDescription(
    "Typed content SDK — collect, validate, and generate importable data",
  ),
  Command.withSubcommands([build, watch]),
);

/**
 * Live layer for the CLI: Anhur services + Node platform (stdio, terminal, …).
 */
export const mainLayer = Layer.mergeAll(nodeLiveLayer, NodeServices.layer);

/**
 * Runnable CLI program (provide {@link mainLayer}, then `NodeRuntime.runMain`).
 */
export const run = Command.run(cli, { version: packageVersion }).pipe(
  Effect.provide(mainLayer),
);
