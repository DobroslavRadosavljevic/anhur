import path from "node:path";
import { Effect } from "effect";
import { layer as nodeLiveLayer } from "./layers/node-live";
import {
  Builder,
  type BuildError,
  type BuildOptions,
  type BuildResult,
} from "./services/builder";
import { ConfigLoader, type LoadConfigResult } from "./services/config-loader";

export type { BuildError, BuildOptions, BuildResult };
export type { BuiltSource } from "./services/generator";

/**
 * Resolve config path with Node `path` (sync edge for Vite plugins).
 */
export function resolveConfigPath(
  rootDir: string,
  configPath = "anhur.config.ts",
): string {
  return path.isAbsolute(configPath)
    ? configPath
    : path.resolve(rootDir, configPath);
}

/**
 * Effect program: load config → collect → generate `.anhur/generated`.
 * Requires the Anhur live layer (or equivalent services).
 */
export const buildEffect = (
  options: BuildOptions = {},
): Effect.Effect<BuildResult, BuildError, Builder> =>
  Effect.gen(function* () {
    const builder = yield* Builder;
    return yield* builder.build(options);
  });

/** Promise edge for Vite plugins and other JS hosts. */
export const build = (options: BuildOptions = {}): Promise<BuildResult> =>
  Effect.runPromise(buildEffect(options).pipe(Effect.provide(nodeLiveLayer)));

/** Load `anhur.config.ts` without collecting content (Vite alias, diagnostics). */
export const loadConfig = (
  options: BuildOptions = {},
): Promise<LoadConfigResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const loader = yield* ConfigLoader;
      const rootDir = options.rootDir ?? process.cwd();
      return yield* loader.load(
        rootDir,
        options.configPath ?? "anhur.config.ts",
      );
    }).pipe(Effect.provide(nodeLiveLayer)),
  );
