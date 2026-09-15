import { Effect } from "effect";
import { layer as nodeLiveLayer } from "../layers/node-live";
import { buildEffect, type BuildOptions, type BuildResult } from "../build";
import { ConfigLoader, type LoadConfigResult } from "../services/config-loader";
import {
  watchEffect,
  type WatchController,
  type WatchHandlers,
  type WatchOptions,
} from "../watch";
import { runEffectPromise } from "./run-effect";

/** Promise edge for Vite plugins and other JS hosts. */
export const build = (options: BuildOptions = {}): Promise<BuildResult> =>
  runEffectPromise(buildEffect(options).pipe(Effect.provide(nodeLiveLayer)));

const loadConfigEffect = Effect.fn("loadConfigEffect")(function* (
  options: BuildOptions = {},
) {
  const loader = yield* ConfigLoader;
  const rootDir = options.rootDir ?? process.cwd();
  return yield* loader.load(rootDir, options.configPath ?? "anhur.config.ts");
});

/** Load `anhur.config.ts` without collecting content (Vite alias, diagnostics). */
export const loadConfig = (
  options: BuildOptions = {},
): Promise<LoadConfigResult> =>
  runEffectPromise(
    loadConfigEffect(options).pipe(Effect.provide(nodeLiveLayer)),
  );

/** Promise edge for CLI hosts and non-Vite tooling. */
export const watch = (
  options: WatchOptions = {},
  handlers: WatchHandlers = {},
): Promise<WatchController> =>
  runEffectPromise(
    watchEffect(options, handlers).pipe(Effect.provide(nodeLiveLayer)),
  );
