import path from "node:path";
import { Cause, Effect, Exit, Fiber, ManagedRuntime, Result } from "effect";
import {
  AnhurBuildError,
  errorDiagnostic,
  messageOf,
} from "../diagnostics";
import { BuildFailedError } from "../engine/build-failed";
import { Engine } from "../engine/engine.service";
import { AnhurLive } from "../engine/live";
import type { BuildOptions, BuildResult, WatchTargets } from "../engine/result";
import { Watcher, type WatchOptions } from "../engine/watcher.service";

/** A long-lived build session (one per dev server / watcher / CLI run). */
export type AnhurSession = {
  /** Build with the session defaults (plus overrides). Rejects with {@link AnhurBuildError}. */
  readonly build: (overrides?: BuildOptions) => Promise<BuildResult>;
  /** Folders / files to watch, also after a failed build. */
  readonly watchTargets: (overrides?: BuildOptions) => Promise<WatchTargets>;
  /** Release caches and services. */
  readonly close: () => Promise<void>;
};

function relativeRoot(options: BuildOptions): string {
  return path.resolve(options.rootDir ?? process.cwd());
}

/** Convert any failure cause into an {@link AnhurBuildError}. */
export function toAnhurError(
  cause: Cause.Cause<BuildFailedError>,
  relativeTo: string,
): AnhurBuildError {
  const typed = Cause.findError(cause);
  if (Result.isSuccess(typed)) {
    return new AnhurBuildError(typed.success.diagnostics, { relativeTo });
  }
  const defect = Cause.squash(cause);
  return new AnhurBuildError(
    [
      errorDiagnostic("internal", `Unexpected error: ${messageOf(defect)}`, {
        cause: defect,
        hint: "This is a bug in Anhur or a plugin. Please report it with the stack trace.",
      }),
    ],
    { relativeTo },
  );
}

/**
 * Create a build session. Caches (config, validated documents, asset
 * hashes) live as long as the session, so repeated builds only redo work
 * for changed files.
 */
export function createAnhur(defaults: BuildOptions = {}): AnhurSession {
  const runtime = ManagedRuntime.make(AnhurLive);
  const run = async <A>(
    program: Effect.Effect<A, BuildFailedError, Engine>,
    options: BuildOptions,
  ): Promise<A> => {
    const exit = await runtime.runPromiseExit(program);
    if (Exit.isSuccess(exit)) return exit.value;
    throw toAnhurError(exit.cause, relativeRoot(options));
  };
  return {
    build: (overrides = {}) => {
      const options = { ...defaults, ...overrides };
      return run(Engine.use((engine) => engine.build(options)), options);
    },
    watchTargets: (overrides = {}) => {
      const options = { ...defaults, ...overrides };
      return run(Engine.use((engine) => engine.watchTargets(options)), options);
    },
    close: () => runtime.dispose(),
  };
}

/** Build once and release the session. Rejects with {@link AnhurBuildError}. */
export async function build(options: BuildOptions = {}): Promise<BuildResult> {
  const session = createAnhur(options);
  try {
    return await session.build();
  } finally {
    await session.close();
  }
}

/** Validate everything without writing output (`anhur check`). */
export function check(options: BuildOptions = {}): Promise<BuildResult> {
  return build({ ...options, dryRun: true });
}

export type WatchHandlers = {
  readonly onBuild?: (result: BuildResult) => void | Promise<void>;
  readonly onError?: (error: AnhurBuildError) => void | Promise<void>;
};

export type WatchController = {
  /** Stop watching and release the session. */
  readonly close: () => Promise<void>;
};

/**
 * Build, then rebuild on every relevant change until `close()`. Failed
 * builds call `onError`; the watcher keeps running.
 */
export async function watch(
  options: WatchOptions = {},
  handlers: WatchHandlers = {},
): Promise<WatchController> {
  const runtime = ManagedRuntime.make(AnhurLive);
  const relativeTo = relativeRoot(options);
  const notify = (label: string, callback: () => void | Promise<void>) =>
    Effect.tryPromise({
      try: async () => {
        await callback();
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError("Watch handler failed", { handler: label, error: messageOf(cause) }),
      ),
    );
  const program = Effect.scoped(
    Watcher.use((watcher) =>
      watcher.run(
        { mode: "dev", ...options },
        {
          onBuild: (result) => notify("onBuild", () => handlers.onBuild?.(result)),
          onError: (error) =>
            notify("onError", () =>
              handlers.onError?.(new AnhurBuildError(error.diagnostics, { relativeTo })),
            ),
        },
      ),
    ),
  );
  const fiber = runtime.runFork(program);
  return {
    close: async () => {
      await runtime.runPromise(Fiber.interrupt(fiber));
      await runtime.dispose();
    },
  };
}
