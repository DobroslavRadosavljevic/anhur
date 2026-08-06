import { Effect } from "effect";
import { layer as nodeLiveLayer } from "./layers/node-live";
import {
  Watcher,
  type WatchController,
  type WatchHandlers,
  type WatchOptions,
} from "./services/watcher";

export type { WatchController, WatchHandlers, WatchOptions };

/**
 * Watch content + config; rebuild via the Builder service.
 * Requires the Anhur live layer (or equivalent services).
 */
export const watchEffect = (
  options: WatchOptions = {},
  handlers: WatchHandlers = {},
): Effect.Effect<WatchController, never, Watcher> =>
  Effect.gen(function* () {
    const watcher = yield* Watcher;
    return yield* watcher.start(options, handlers);
  });

/** Promise edge for CLI hosts and non-Vite tooling. */
export const watch = (
  options: WatchOptions = {},
  handlers: WatchHandlers = {},
): Promise<WatchController> =>
  Effect.runPromise(
    watchEffect(options, handlers).pipe(Effect.provide(nodeLiveLayer)),
  );
