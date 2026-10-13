import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { Effect } from "effect";
import { messageOf } from "../diagnostics";
import { FileWorkError } from "./file-work";
import type {
  WireFile,
  WireResult,
  WorkerReply,
  WorkerRequest,
  WorkerSetup,
} from "./validation-wire";

/** Files sent to a worker at once: few messages, and no worker runs dry while another has a long list. */
const BATCH_SIZE = 8;
/** A worker that has not loaded the project by then is given up on. */
const START_TIMEOUT_MS = 120_000;

export type PoolSettings = {
  /** Number of workers to start. */
  readonly workers: number;
  readonly dryRun: boolean;
  readonly readAt: number;
};

export type PoolOutcome = {
  /** One result per file, in order; `undefined` where no worker finished the file. */
  readonly results: readonly (WireResult | undefined)[];
  /** Why workers could not be used (for some or all files). */
  readonly problem: string | undefined;
};

type Entry = {
  /** Path of the worker module. */
  readonly file: string;
  /**
   * Node flags of the worker. `undefined`: the flags of this process
   * (`--conditions`, `--import`, …), so a worker resolves modules the way
   * the main thread does.
   */
  readonly execArgv: readonly string[] | undefined;
};

/**
 * The worker module next to this one: `worker.js` in a build, the
 * TypeScript source in the workspace (Bun runs it as is; Node needs jiti,
 * which `@anhur/core` already depends on).
 */
function workerEntry(): Entry {
  const here = fileURLToPath(import.meta.url);
  if (!/\.[cm]?ts$/.test(here)) {
    return {
      file: path.join(path.dirname(here), "worker.js"),
      execArgv: undefined,
    };
  }
  const file = path.join(path.dirname(here), "..", "worker", "validation.ts");
  const inherited = process.execArgv;
  if (
    process.versions.bun !== undefined ||
    inherited.some((flag) => flag.includes("jiti"))
  ) {
    return { file, execArgv: undefined };
  }
  // `jiti/register` is an import-only export: find it through the package.
  const jiti = createRequire(import.meta.url).resolve("jiti/package.json");
  const register = path.join(path.dirname(jiti), "lib", "jiti-register.mjs");
  return {
    file,
    execArgv: [...inherited, "--import", pathToFileURL(register).href],
  };
}

function isReply(value: unknown): value is WorkerReply {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    (value.type === "ready" || value.type === "failed" || value.type === "done")
  );
}

/**
 * Validate `files` in worker threads. Every worker loads the project from
 * the config file itself, then takes batches of files until none are left.
 * A worker that cannot start, fails or dies gives its unfinished files
 * back as `undefined`; the caller validates those itself. Never rejects.
 */
export async function validateInWorkers(
  setup: WorkerSetup,
  files: readonly WireFile[],
  settings: PoolSettings,
): Promise<PoolOutcome> {
  const results: (WireResult | undefined)[] = [];
  results.length = files.length;
  let problem: string | undefined;
  let entry: Entry;
  try {
    entry = workerEntry();
  } catch (cause) {
    return { results, problem: messageOf(cause) };
  }
  let next = 0;
  let requests = 0;

  const run = (): Promise<void> =>
    new Promise((resolve) => {
      let worker: Worker;
      try {
        worker = new Worker(entry.file, {
          workerData: setup,
          ...(entry.execArgv ? { execArgv: [...entry.execArgv] } : {}),
        });
      } catch (cause) {
        problem ??= messageOf(cause);
        resolve();
        return;
      }
      /** Position in `files` of the first file of the batch being worked on. */
      let pending: { readonly id: number; readonly start: number } | undefined;
      let finished = false;
      const starting = setTimeout(() => {
        problem ??= "a worker did not start in time";
        finish();
      }, START_TIMEOUT_MS);
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(starting);
        void worker.terminate().catch(() => undefined);
        resolve();
      };
      const send = (): void => {
        if (next >= files.length) {
          finish();
          return;
        }
        const start = next;
        next = Math.min(files.length, start + BATCH_SIZE);
        requests += 1;
        pending = { id: requests, start };
        const request: WorkerRequest = {
          id: requests,
          files: files.slice(start, next),
          dryRun: settings.dryRun,
          readAt: settings.readAt,
        };
        worker.postMessage(request);
      };
      worker.on("message", (input: unknown) => {
        if (finished || !isReply(input)) return;
        const reply = input;
        if (reply.type === "failed") {
          problem ??= reply.message;
          finish();
          return;
        }
        if (reply.type === "ready") {
          clearTimeout(starting);
          send();
          return;
        }
        if (!pending || pending.id !== reply.id) return;
        for (const [offset, result] of reply.results.entries()) {
          results[pending.start + offset] = result;
        }
        pending = undefined;
        send();
      });
      worker.on("error", (cause) => {
        problem ??= messageOf(cause);
        finish();
      });
      worker.on("exit", () => {
        if (!finished) problem ??= "a worker stopped before it was done";
        finish();
      });
    });

  await Promise.all(
    Array.from({ length: Math.max(1, settings.workers) }, () => run()),
  );
  return { results, problem };
}

/**
 * Run {@link validateInWorkers} as an effect. It has no deadline of its
 * own: every worker has a start deadline, and loaders, fields and schemas
 * have theirs inside the worker, as in the main thread.
 */
export function poolWork<A>(run: () => Promise<A>): Effect.Effect<A> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new FileWorkError({ message: messageOf(cause) }),
  }).pipe(Effect.orDie);
}
