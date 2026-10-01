import { realpathSync } from "node:fs";
import path from "node:path";
import {
  Cause,
  Context,
  Effect,
  Fiber,
  FiberMap,
  FileSystem,
  Layer,
  Queue,
  Ref,
  Result,
  Semaphore,
  Stream,
  type Scope,
} from "effect";
import { errorDiagnostic } from "../diagnostics";
import { BuildFailedError, buildFailed } from "./build-failed";
import { Engine } from "./engine.service";
import { isInside } from "./paths";
import type { BuildOptions, BuildResult, WatchTargets } from "./result";

const DEBOUNCE = "75 millis";
const TEMP_FILE =
  /(?:~|\.swp|\.swx|\.swo|\.tmp|\.crdownload|\.part)$|^4913$|^#.*#$/;

/** Callbacks of a watch session. */
export type WatchEvents = {
  readonly onBuild: (result: BuildResult) => Effect.Effect<void>;
  readonly onError: (error: BuildFailedError) => Effect.Effect<void>;
};

export type WatchOptions = BuildOptions & {
  /** Build once before waiting for changes (default true). */
  readonly immediate?: boolean;
};

type WatchKey = `${"r" | "f"}:${string}`;

function isIgnoredName(file: string): boolean {
  const name = path.basename(file);
  return name.startsWith(".") || TEMP_FILE.test(name);
}

function classify(
  file: string,
  targets: WatchTargets,
): "ignored" | "relevant" | "unknown" {
  if (targets.ignore.some((dir) => isInside(file, dir))) return "ignored";
  if (targets.files.includes(file)) return "relevant";
  if (isIgnoredName(file)) return "ignored";
  if (file.split(path.sep).includes("node_modules")) return "ignored";
  return targets.directories.some((dir) => isInside(file, dir))
    ? "relevant"
    : "unknown";
}

/** Real path of a file, or of its folder when the file was deleted. */
function realPathOf(file: string): string | undefined {
  try {
    return realpathSync.native(file);
  } catch {
    try {
      return path.join(
        realpathSync.native(path.dirname(file)),
        path.basename(file),
      );
    } catch {
      return undefined;
    }
  }
}

/**
 * True when a change at `file` should trigger a rebuild. Targets are real
 * paths; a path reported through a symlink (or with different case on a
 * case-insensitive disk) is resolved before giving up.
 */
export function isRelevantChange(file: string, targets: WatchTargets): boolean {
  const direct = classify(file, targets);
  if (direct !== "unknown") return direct === "relevant";
  const real = realPathOf(file);
  return real !== undefined && real !== file
    ? classify(real, targets) === "relevant"
    : false;
}

/** Folders to watch: content roots recursively, parents of single files not. */
function watchKeys(targets: WatchTargets): Set<WatchKey> {
  const keys = new Set<WatchKey>();
  for (const dir of targets.directories) keys.add(`r:${dir}`);
  for (const file of targets.files) {
    if (targets.directories.some((dir) => isInside(file, dir))) continue;
    keys.add(`f:${path.dirname(file)}`);
  }
  return keys;
}

/** Turn any build cause (typed failure or defect) into a `BuildFailedError`. */
function toBuildError(cause: Cause.Cause<BuildFailedError>): BuildFailedError {
  const typed = Cause.findError(cause);
  if (Result.isSuccess(typed)) return typed.success;
  return buildFailed([
    errorDiagnostic("internal", `Unexpected error: ${Cause.pretty(cause)}`, {
      cause: Cause.squash(cause),
      hint: "This is a bug in Anhur or a plugin. The watcher keeps running.",
    }),
  ]);
}

/**
 * Rebuilds on file changes. Watches content roots recursively and the
 * folders of single dependency files, re-syncs the watched folders after
 * every build (new collections, config imports, asset sources), ignores
 * Anhur's own output, and never stops on a failed build or a defect.
 */
export class Watcher extends Context.Service<
  Watcher,
  {
    /** Run until the scope closes. */
    readonly run: (
      options: WatchOptions,
      events: WatchEvents,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@anhur/core/engine/Watcher") {
  static readonly layer = Layer.effect(
    Watcher,
    Effect.gen(function* () {
      const engine = yield* Engine;
      const fs = yield* FileSystem.FileSystem;

      const run = Effect.fn("Watcher.run")(function* (
        options: WatchOptions,
        events: WatchEvents,
      ) {
        const changes = yield* Queue.sliding<string>(1024);
        const watchers = yield* FiberMap.make<WatchKey>();
        const targets = yield* Ref.make<WatchTargets>({
          directories: [],
          files: [],
          ignore: [],
        });
        const active = yield* Ref.make<ReadonlySet<WatchKey>>(new Set());
        const syncPermit = yield* Semaphore.make(1);

        const watchFolder = Effect.fn("Watcher.watchFolder")(function* (
          key: WatchKey,
        ) {
          const recursive = key.startsWith("r:");
          const dir = key.slice(2);
          yield* fs.watch(dir, { recursive }).pipe(
            Stream.runForEach(
              Effect.fnUntraced(function* (event: FileSystem.WatchEvent) {
                const file = path.resolve(dir, event.path);
                const current = yield* Ref.get(targets);
                if (isRelevantChange(file, current))
                  yield* Queue.offer(changes, file);
              }),
            ),
            Effect.catch((error) =>
              Effect.logWarning("Watching a folder stopped", {
                folder: dir,
                error: error.message,
              }),
            ),
          );
        });

        const syncNow = Effect.fn("Watcher.syncNow")(function* () {
          const next = yield* engine.watchTargets(options);
          yield* Ref.set(targets, next);
          const wanted = watchKeys(next);
          const running = yield* Ref.get(active);
          const now = new Set<WatchKey>();
          for (const key of running) {
            if (!wanted.has(key)) yield* FiberMap.remove(watchers, key);
            // A watcher whose folder was deleted has ended; start it again below.
            else if (yield* FiberMap.has(watchers, key)) now.add(key);
          }
          for (const key of wanted) {
            if (now.has(key)) continue;
            const exists = yield* fs
              .exists(key.slice(2))
              .pipe(Effect.orElseSucceed(() => false));
            if (!exists) continue;
            yield* FiberMap.run(watchers, key, watchFolder(key));
            now.add(key);
          }
          yield* Ref.set(active, now);
        });
        const sync = () => syncPermit.withPermits(1)(syncNow());

        const rebuild = Effect.fn("Watcher.rebuild")(function* () {
          yield* engine.build(options).pipe(
            Effect.matchCauseEffect({
              onSuccess: (result) => events.onBuild(result),
              onFailure: (cause) => events.onError(toBuildError(cause)),
            }),
          );
          yield* sync();
        });

        if (options.immediate === false) {
          yield* sync();
        } else {
          // Start watching as soon as the config is loaded (the engine knows
          // the content folders from then on), so edits made during a long
          // first build trigger another build instead of being lost.
          const first = yield* Effect.forkScoped(rebuild());
          const watchEarly = Effect.gen(function* () {
            for (;;) {
              const known = yield* engine.watchTargets(options);
              if (known.directories.length > 0) return yield* sync();
              yield* Effect.sleep("50 millis");
            }
          });
          yield* Effect.raceFirst(Fiber.join(first), watchEarly);
          yield* Fiber.join(first);
        }

        yield* Stream.fromQueue(changes).pipe(
          Stream.debounce(DEBOUNCE),
          Stream.runForEach(() => rebuild()),
        );
      });

      return Watcher.of({ run });
    }),
  );
}
