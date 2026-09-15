import path from "node:path";
import { Effect } from "effect";
import { runEffectPromise } from "./cli/run-effect";
import { layer as nodeLiveLayer } from "./layers/node-live";
import {
  ConfigLoader,
  type LoadConfigError,
  type LoadConfigResult,
} from "./services/config-loader";
import {
  Builder,
  type BuildError,
  type BuildOptions,
  type BuildResult,
} from "./services/builder";

export type { BuildError, BuildOptions, BuildResult };

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
  Effect.fn("buildEffect")(function* () {
    const builder = yield* Builder;
    return yield* builder.build(options);
  })();

/** Promise edge for Vite plugins and other JS hosts. */
export const build = (options: BuildOptions = {}): Promise<BuildResult> =>
  runEffectPromise(buildEffect(options).pipe(Effect.provide(nodeLiveLayer)));

const loadConfigEffect = (
  options: BuildOptions = {},
): Effect.Effect<LoadConfigResult, LoadConfigError, ConfigLoader> =>
  Effect.fn("loadConfigEffect")(function* () {
    const loader = yield* ConfigLoader;
    const rootDir = options.rootDir ?? process.cwd();
    return yield* loader.load(rootDir, options.configPath ?? "anhur.config.ts");
  })();

/** Load `anhur.config.ts` without collecting content (Vite alias, diagnostics). */
export const loadConfig = (
  options: BuildOptions = {},
): Promise<LoadConfigResult> =>
  runEffectPromise(
    loadConfigEffect(options).pipe(Effect.provide(nodeLiveLayer)),
  );
