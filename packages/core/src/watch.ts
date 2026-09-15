import { Effect } from "effect";
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
  Effect.fn("watchEffect")(function* () {
    const watcher = yield* Watcher;
    return yield* watcher.start(options, handlers);
  })();
