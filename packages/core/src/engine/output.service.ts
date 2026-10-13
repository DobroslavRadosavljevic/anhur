import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  type Scope,
} from "effect";
import { errorDiagnostic, messageOf } from "../diagnostics";
import { BuildFailedError, buildFailed } from "./build-failed";
import type { OutputFile, PlanRevision } from "./codegen";
import { fileWork } from "./file-work";
import {
  adoptLegacy,
  createOutputState,
  currentManifest,
  writeOutputFiles,
  type OutputState,
  type WriteResult,
} from "./output-files";

const LOCK_WAIT_MS = 60_000;
const LOCK_POLL = "100 millis";
const STALE_LOCK_MS = 10 * 60_000;
/** The holder rewrites the lock this often, so a long build never looks stale. */
const LOCK_HEARTBEAT = "1 minute";
/** A lock that cannot be read yet may be mid-write; only older ones are stale. */
const UNREADABLE_LOCK_GRACE_MS = 30_000;
const WRITE_TIMEOUT = "30 minutes";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (
      Predicate.isObject(cause) && "code" in cause && cause.code === "EPERM"
    );
  }
}

type LockOwner = {
  readonly token: string;
  readonly pid: number;
  readonly host: string;
  readonly startedAt: number;
};

function parseLock(text: string): LockOwner | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    Predicate.isObject(raw) &&
    "token" in raw &&
    Predicate.isString(raw.token) &&
    "pid" in raw &&
    Predicate.isNumber(raw.pid) &&
    "host" in raw &&
    Predicate.isString(raw.host) &&
    "startedAt" in raw &&
    Predicate.isNumber(raw.startedAt)
  ) {
    return {
      token: raw.token,
      pid: raw.pid,
      host: raw.host,
      startedAt: raw.startedAt,
    };
  }
  return undefined;
}

/**
 * Owns the generated output folder: ownership check, an exclusive lock
 * (shared across processes through `<outputDir>.lock`), and diff writes
 * with per-file atomic renames. Only files listed in the manifest are ever
 * deleted.
 */
export class OutputWriter extends Context.Service<
  OutputWriter,
  {
    /** Hold the output lock for the current scope. */
    readonly lock: (
      outputDir: string,
    ) => Effect.Effect<void, BuildFailedError, Scope.Scope>;
    /** Fail unless the folder is missing, empty, or Anhur output. */
    readonly checkOwnership: (
      outputDir: string,
    ) => Effect.Effect<void, BuildFailedError>;
    /**
     * Write changed files, delete stale ones, update the manifest.
     * `revision` is `OutputPlan.revision` of the plan the files come from.
     */
    readonly write: (
      outputDir: string,
      files: readonly OutputFile[],
      revision: PlanRevision,
    ) => Effect.Effect<WriteResult, BuildFailedError>;
  }
>()("@anhur/core/engine/OutputWriter") {
  static readonly layer = Layer.effect(
    OutputWriter,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const failed = (message: string, hint?: string) =>
        buildFailed([errorDiagnostic("publish-failed", message, { hint })]);

      /** What this session knows about each output folder it wrote. */
      const states = new Map<string, OutputState>();
      const stateOf = (outputDir: string): OutputState => {
        let state = states.get(outputDir);
        if (!state) {
          state = createOutputState();
          states.set(outputDir, state);
        }
        return state;
      };

      const checkOwnership = Effect.fn("OutputWriter.checkOwnership")(
        function* (outputDir: string) {
          const info = yield* fs.stat(outputDir).pipe(Effect.option);
          if (Option.isNone(info)) return;
          if (info.value.type !== "Directory") {
            return yield* Effect.fail(
              buildFailed([
                errorDiagnostic(
                  "output-unsafe",
                  `outputDir "${outputDir}" is a file, not a folder.`,
                ),
              ]),
            );
          }
          const manifest = yield* fileWork(() =>
            currentManifest(outputDir, stateOf(outputDir)),
          );
          if (manifest) return;
          const entries = yield* fs
            .readDirectory(outputDir)
            .pipe(Effect.orElseSucceed((): string[] => []));
          if (entries.length === 0) return;
          const legacy = yield* fileWork(() => adoptLegacy(outputDir));
          if (legacy) return;
          return yield* Effect.fail(
            buildFailed([
              errorDiagnostic(
                "output-unsafe",
                `outputDir "${outputDir}" already exists and was not created by Anhur; refusing to write into it.`,
                {
                  hint: "Delete the folder, or set outputDir to a dedicated folder such as .anhur/generated.",
                },
              ),
            ]),
          );
        },
      );

      /** Write a file with its full contents next to the target, then move it into place. */
      const writeBeside = Effect.fn("OutputWriter.writeBeside")(function* (
        target: string,
        contents: string,
      ) {
        const temporary = `${target}.${randomUUID().slice(0, 8)}.tmp`;
        yield* fs.writeFileString(temporary, contents);
        return temporary;
      });

      /**
       * Create the lock atomically with its contents: hard-link a fully
       * written file into place (fails when the lock exists), so another
       * process never sees an empty lock.
       */
      const tryCreateLock = Effect.fn("OutputWriter.tryCreateLock")(function* (
        lockPath: string,
        owner: LockOwner,
      ) {
        const temporary = yield* writeBeside(
          lockPath,
          JSON.stringify(owner),
        ).pipe(
          Effect.mapError((error) =>
            failed(
              `Could not create the output lock ${lockPath}: ${error.message}`,
            ),
          ),
        );
        const created = yield* fs.link(temporary, lockPath).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            error.reason._tag === "AlreadyExists"
              ? Effect.succeed(false)
              : Effect.fail(
                  failed(
                    `Could not create the output lock ${lockPath}: ${error.message}`,
                  ),
                ),
          ),
          Effect.ensuring(
            fs.remove(temporary, { force: true }).pipe(
              Effect.ignore({
                log: "Warn",
                message: "Removing a temporary lock file failed",
              }),
            ),
          ),
        );
        return created;
      });

      const clearIfStale = Effect.fn("OutputWriter.clearIfStale")(function* (
        lockPath: string,
        now: number,
      ) {
        const text = yield* fs.readFileString(lockPath).pipe(Effect.option);
        if (Option.isNone(text)) return true;
        const owner = parseLock(text.value);
        let stale: boolean;
        if (owner) {
          stale =
            now - owner.startedAt > STALE_LOCK_MS ||
            (owner.host === hostname() && !processAlive(owner.pid));
        } else {
          const info = yield* fs.stat(lockPath).pipe(Effect.option);
          const modified = Option.isSome(info)
            ? Option.getOrElse(info.value.mtime, () => new Date(0)).getTime()
            : 0;
          stale = now - modified > UNREADABLE_LOCK_GRACE_MS;
        }
        if (!stale) return false;
        // Only remove the lock we judged stale: another waiter may have replaced it meanwhile.
        const again = yield* fs.readFileString(lockPath).pipe(Effect.option);
        if (Option.isSome(again) && again.value !== text.value) return false;
        yield* fs.remove(lockPath, { force: true }).pipe(
          Effect.ignore({
            log: "Warn",
            message: "Removing a stale output lock failed",
          }),
        );
        return true;
      });

      /** Keep a held lock fresh while a long build runs. */
      const heartbeat = Effect.fn("OutputWriter.heartbeat")(function* (
        lockPath: string,
        owner: LockOwner,
      ) {
        for (;;) {
          yield* Effect.sleep(LOCK_HEARTBEAT);
          const text = yield* fs.readFileString(lockPath).pipe(Effect.option);
          if (
            Option.isNone(text) ||
            parseLock(text.value)?.token !== owner.token
          )
            return;
          const now = yield* Clock.currentTimeMillis;
          const temporary = yield* writeBeside(
            lockPath,
            JSON.stringify({ ...owner, startedAt: now }),
          );
          yield* fs.rename(temporary, lockPath);
        }
      });

      const lock = Effect.fn("OutputWriter.lock")(function* (
        outputDir: string,
      ) {
        const lockPath = `${outputDir}.lock`;
        yield* fs
          .makeDirectory(path.dirname(lockPath), { recursive: true })
          .pipe(
            Effect.mapError((error) =>
              failed(
                `Could not create ${path.dirname(lockPath)}: ${error.message}`,
              ),
            ),
          );
        const token = randomUUID();
        const ownerNow = Effect.map(
          Clock.currentTimeMillis,
          (startedAt): LockOwner => ({
            token,
            pid: process.pid,
            host: hostname(),
            startedAt,
          }),
        );
        let owner = yield* ownerNow;
        let waitedFor = 0;
        while (!(yield* tryCreateLock(lockPath, owner))) {
          const now = yield* Clock.currentTimeMillis;
          if (yield* clearIfStale(lockPath, now)) continue;
          if (waitedFor >= LOCK_WAIT_MS) {
            return yield* Effect.fail(
              buildFailed([
                errorDiagnostic(
                  "output-locked",
                  `Another Anhur build is writing ${outputDir} (lock ${lockPath}).`,
                  {
                    hint: "Wait for it to finish, or delete the lock file if no build is running.",
                  },
                ),
              ]),
            );
          }
          yield* Effect.sleep(LOCK_POLL);
          waitedFor += 100;
          owner = yield* ownerNow;
        }
        yield* heartbeat(lockPath, owner).pipe(
          Effect.ignore({
            log: "Warn",
            message: "Refreshing the output lock failed",
          }),
          Effect.forkScoped,
        );
        yield* Effect.addFinalizer(() =>
          fs.readFileString(lockPath).pipe(
            Effect.flatMap((text) =>
              parseLock(text)?.token === token
                ? fs.remove(lockPath, { force: true })
                : Effect.void,
            ),
            Effect.ignore({
              log: "Warn",
              message: "Releasing the output lock failed",
            }),
          ),
        );
      });

      const write = Effect.fn("OutputWriter.write")(function* (
        outputDir: string,
        files: readonly OutputFile[],
        revision: PlanRevision,
      ) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.tryPromise({
          try: () =>
            writeOutputFiles(
              outputDir,
              files,
              revision,
              stateOf(outputDir),
              now,
            ),
          catch: (cause) => failed(messageOf(cause)),
        }).pipe(
          Effect.timeoutOrElse({
            duration: WRITE_TIMEOUT,
            orElse: () =>
              Effect.fail(
                failed(
                  `Writing the output did not finish within ${WRITE_TIMEOUT}.`,
                ),
              ),
          }),
        );
      });

      return OutputWriter.of({ lock, checkOwnership, write });
    }),
  );
}
