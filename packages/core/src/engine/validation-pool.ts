import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { Duration, Effect } from "effect";
import { messageOf } from "../diagnostics";
import { FileWorkError } from "./file-work";
import {
  isWorkerReply,
  type WireFile,
  type WireResult,
  type WorkerRequest,
  type WorkerSetup,
} from "./validation-wire";

/** Files sent to a worker at once: few messages, and no worker runs dry while another has a long list. */
const BATCH_SIZE = 8;
/**
 * A worker that has not loaded the project by then is given up on. The
 * main thread loaded the same config a moment ago, and a worker loads the
 * engine and the compilers too: a good start takes a second or two. The
 * config loader allows 2 minutes, but here the main thread only waits,
 * and a limit that is too short costs little: the main thread does the
 * files then.
 */
const START_TIMEOUT_MS = 30_000;
/**
 * A worker that has not answered a batch by then is stopped. A file may
 * take 1 minute to load, 5 minutes for each field (four at once) and 5
 * minutes in its schema: 11 minutes when one round of fields goes to the
 * limit. The files of a batch run at the same time, so a batch gets the
 * same, plus room. Those limits end work that waits. This one ends a
 * thread that is blocked (an endless loop, a slow regular expression):
 * no limit inside the worker can fire there.
 */
const BATCH_TIMEOUT_MS = 15 * 60_000;
/**
 * `terminate()` stops JavaScript at once. A thread inside a blocking
 * native call stops when that call returns: the build waits this long for
 * it, then goes on. The thread runs no JavaScript after the call.
 */
const STOP_TIMEOUT_MS = 10_000;

export type PoolSettings = {
  /** Number of workers to start. */
  readonly workers: number;
  readonly dryRun: boolean;
  readonly readAt: number;
  /** Aborted when the build is given up: the pool stops every worker. */
  readonly signal?: AbortSignal;
  /** Milliseconds a worker may take to load the project. */
  readonly startTimeoutMs?: number;
  /** Milliseconds a worker may take for one batch of files. */
  readonly batchTimeoutMs?: number;
};

export type PoolOutcome = {
  /** One result per file, in order; `undefined` where no worker finished the file. */
  readonly results: readonly (WireResult | undefined)[];
  /** Why workers could not be used (for some or all files). */
  readonly problem: string | undefined;
  /**
   * True when no worker could load the project. The next build of the
   * same project would start workers for nothing again.
   */
  readonly unusable: boolean;
};

type Entry = {
  /** Path of the worker module, or code to run when `evaluate` is true. */
  readonly source: string;
  readonly evaluate: boolean;
};

/**
 * The worker module next to this one: `worker.js` in a build, the
 * TypeScript source in the workspace. Bun runs the source as it is, and so
 * does Node when the process was started with jiti (`--import
 * jiti/register`): a worker gets the flags of the process. Any other Node
 * process (jiti used from code, Vitest) starts the worker from a line of
 * code that registers jiti first; `@anhur/core` depends on jiti already.
 *
 * The flags of the process are never passed on by hand: Node refuses
 * process flags (`--expose-gc`, `--max-old-space-size`) in a worker's own
 * list.
 */
function workerEntry(): Entry {
  const here = fileURLToPath(import.meta.url);
  if (!/\.[cm]?ts$/.test(here)) {
    return {
      source: path.join(path.dirname(here), "worker.js"),
      evaluate: false,
    };
  }
  const file = path.join(path.dirname(here), "..", "worker", "validation.ts");
  if (
    process.versions.bun !== undefined ||
    process.execArgv.some((flag) => flag.includes("jiti"))
  ) {
    return { source: file, evaluate: false };
  }
  // `jiti/register` is an import-only export: find it through the package.
  const jiti = createRequire(import.meta.url).resolve("jiti/package.json");
  const register = path.join(path.dirname(jiti), "lib", "jiti-register.mjs");
  const urls = [pathToFileURL(register).href, pathToFileURL(file).href];
  return {
    source: `import(${JSON.stringify(urls[0])}).then(() => import(${JSON.stringify(urls[1])}));`,
    evaluate: true,
  };
}

const NO_REASON = "a worker failed with an error that has no message";

/** Why a worker failed: never empty (an error can lose its message between threads). */
function reasonOf(cause: unknown): string {
  const text = messageOf(cause).trim();
  if (text !== "") return text;
  const name = cause instanceof Error ? cause.name : "";
  return name === "" || name === "Error"
    ? NO_REASON
    : `a worker failed with ${name}`;
}

/** Stop a worker and wait until its thread is gone. */
function stop(worker: Worker): Promise<void> {
  return new Promise((resolve) => {
    const waiting = setTimeout(() => {
      // It must not keep the process open either.
      worker.unref();
      resolve();
    }, STOP_TIMEOUT_MS);
    const stopped = (): void => {
      clearTimeout(waiting);
      resolve();
    };
    worker.terminate().then(stopped, stopped);
  });
}

/** The result of a file whose worker was stopped at the batch limit. */
function unfinished(file: WireFile, limitMs: number): WireResult {
  const limit = Duration.format(Duration.millis(limitMs));
  return {
    ok: false,
    diagnostics: [
      {
        code: "validation-failed",
        severity: "error",
        message: `The document did not finish in a worker thread within ${limit}: it, or a document validated with it, blocks the thread.`,
        file: file.absPath,
        source: file.source,
        hint: "A loader, field or schema never gives the thread back (an endless loop, a slow regular expression). Set workers: false in defineConfig() to compile in the main thread and see which one hangs.",
      },
    ],
  };
}

/**
 * Validate `files` in worker threads. Every worker loads the project from
 * the config file itself, then takes batches of files until none are left.
 *
 * - A worker that cannot start, fails or dies gives its unfinished files
 *   back as `undefined`; the caller validates those itself.
 * - A worker that does not answer a batch in time is stopped. Its files
 *   fail with a diagnostic and are not run again: they would block the
 *   caller too. A new worker takes its place while files wait.
 * - When `settings.signal` aborts, no more batches go out and every
 *   worker is stopped.
 *
 * Never rejects. Resolves only after every worker thread is gone, so
 * nothing of the project runs after it.
 */
export async function validateInWorkers(
  setup: WorkerSetup,
  files: readonly WireFile[],
  settings: PoolSettings,
): Promise<PoolOutcome> {
  const results: (WireResult | undefined)[] = [];
  results.length = files.length;
  const startLimit = settings.startTimeoutMs ?? START_TIMEOUT_MS;
  const batchLimit = settings.batchTimeoutMs ?? BATCH_TIMEOUT_MS;
  const isOver = (): boolean => settings.signal?.aborted === true;
  let problem: string | undefined;
  let entry: Entry;
  try {
    entry = workerEntry();
  } catch (cause) {
    return { results, problem: reasonOf(cause), unusable: true };
  }
  let next = 0;
  let requests = 0;
  /** Workers that loaded the project. */
  let ready = 0;
  /** One per worker thread that runs: stops it. */
  const stops = new Set<() => void>();
  /** The same, for the workers that still load the project. */
  const starting = new Set<() => void>();
  /** One per worker ever started; done when its thread is gone. */
  const runs: Promise<void>[] = [];

  const run = (): Promise<void> =>
    new Promise((resolve) => {
      // Not `unref()`ed: while a worker has files, it is what keeps the
      // process open. It is always stopped before the pool resolves.
      let worker: Worker;
      try {
        worker = new Worker(entry.source, {
          workerData: setup,
          ...(entry.evaluate ? { eval: true } : {}),
        });
      } catch (cause) {
        problem ??= reasonOf(cause);
        resolve();
        return;
      }
      /** The batch being worked on: its positions in `files`. */
      let pending:
        | { readonly id: number; readonly start: number; readonly end: number }
        | undefined;
      let finished = false;
      /** The start limit, then the limit of the batch being worked on. */
      let limit: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(limit);
        stops.delete(finish);
        starting.delete(finish);
        void stop(worker).then(resolve);
      };
      /** Give up on this worker; the caller validates its unfinished files. */
      const fail = (reason: string): void => {
        if (finished) return;
        problem ??= reason;
        finish();
      };
      const expire = (): void => {
        if (finished || !pending) return;
        for (let index = pending.start; index < pending.end; index += 1) {
          results[index] = unfinished(files[index]!, batchLimit);
        }
        pending = undefined;
        // The files that wait get a new worker. Without one the caller
        // could end up with them, and block on the next file like this.
        if (next < files.length && !isOver()) runs.push(run());
        finish();
      };
      const send = (): void => {
        if (isOver()) {
          finish();
          return;
        }
        if (next >= files.length) {
          // Nothing is left for the workers that still load the project.
          for (const end of starting) end();
          finish();
          return;
        }
        const start = next;
        next = Math.min(files.length, start + BATCH_SIZE);
        requests += 1;
        pending = { id: requests, start, end: next };
        const request: WorkerRequest = {
          id: requests,
          files: files.slice(start, next),
          dryRun: settings.dryRun,
          readAt: settings.readAt,
        };
        limit = setTimeout(expire, batchLimit);
        try {
          worker.postMessage(request);
        } catch (cause) {
          fail(reasonOf(cause));
        }
      };
      stops.add(finish);
      starting.add(finish);
      limit = setTimeout(() => {
        fail(
          `a worker did not load the project within ${Duration.format(Duration.millis(startLimit))}`,
        );
      }, startLimit);
      worker.on("message", (input: unknown) => {
        if (finished || !isWorkerReply(input)) return;
        if (input.type === "failed") {
          fail(input.message.trim() === "" ? NO_REASON : input.message);
          return;
        }
        if (input.type === "ready") {
          if (!starting.delete(finish)) return;
          clearTimeout(limit);
          ready += 1;
          send();
          return;
        }
        if (!pending || pending.id !== input.id) return;
        if (input.results.length !== pending.end - pending.start) {
          fail("a worker answered with the wrong number of results");
          return;
        }
        clearTimeout(limit);
        for (const [offset, result] of input.results.entries()) {
          results[pending.start + offset] = result;
        }
        pending = undefined;
        send();
      });
      worker.on("error", (cause) => {
        fail(reasonOf(cause));
      });
      // A reply that cannot be read is a reply that never comes.
      worker.on("messageerror", (cause) => {
        fail(`a reply of a worker could not be read: ${reasonOf(cause)}`);
      });
      worker.on("exit", () => {
        fail("a worker stopped before it was done");
      });
    });

  const stopAll = (): void => {
    for (const end of stops) end();
  };
  if (!isOver()) {
    settings.signal?.addEventListener("abort", stopAll, { once: true });
    for (let count = Math.max(1, settings.workers); count > 0; count -= 1) {
      runs.push(run());
    }
  }
  // A stopped worker may have added one to take its place.
  for (let index = 0; index < runs.length; index += 1) await runs[index];
  settings.signal?.removeEventListener("abort", stopAll);
  return { results, problem, unusable: ready === 0 && !isOver() };
}

/**
 * Run {@link validateInWorkers} as an effect. When the effect is
 * interrupted, the signal given to `run` aborts and the interruption waits
 * until `run` has settled: the pool stops its workers first.
 *
 * It has no deadline of its own: the pool has one for the start of a
 * worker and one for each batch, and loaders, fields and schemas have
 * theirs inside the worker, as in the main thread.
 */
export function poolWork<A>(
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A> {
  return Effect.callback<A>((resume) => {
    const controller = new AbortController();
    const settled = run(controller.signal).then(
      (result) => {
        resume(Effect.succeed(result));
      },
      (cause: unknown) => {
        resume(Effect.die(new FileWorkError({ message: messageOf(cause) })));
      },
    );
    return Effect.callback<void>((done) => {
      controller.abort();
      void settled.then(() => {
        done(Effect.void);
      });
    });
  });
}
