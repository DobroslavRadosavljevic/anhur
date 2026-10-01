import { createHash, randomUUID } from "node:crypto";
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
import { errorDiagnostic } from "../diagnostics";
import { BuildFailedError, buildFailed } from "./build-failed";
import type { OutputFile } from "./codegen";
import { GENERATED_HEADER } from "./serialize";

/** Name of the manifest that marks a folder as Anhur output. */
export const MANIFEST_FILE = ".anhur-manifest.json";
const MANIFEST_VERSION = 1;
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL = "100 millis";
const STALE_LOCK_MS = 10 * 60_000;
/** The holder rewrites the lock this often, so a long build never looks stale. */
const LOCK_HEARTBEAT = "1 minute";
/** A lock that cannot be read yet may be mid-write; only older ones are stale. */
const UNREADABLE_LOCK_GRACE_MS = 30_000;
const SAFE_PATH =
  /^(?:[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\/)*[A-Za-z0-9_@-][A-Za-z0-9_.@-]*$/;

export type WriteResult = {
  /** Absolute paths written in this build. */
  readonly written: readonly string[];
  /** Absolute paths removed in this build. */
  readonly removed: readonly string[];
};

type Manifest = {
  readonly files: ReadonlyMap<string, string>;
};

function contentHash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex").slice(0, 32);
}

function isSafeRelative(file: string): boolean {
  return SAFE_PATH.test(file) && !file.split("/").includes("..");
}

function parseManifest(text: string): Manifest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !Predicate.isObject(raw) ||
    !("version" in raw) ||
    raw.version !== MANIFEST_VERSION ||
    !("files" in raw) ||
    !Predicate.isObject(raw.files)
  ) {
    return undefined;
  }
  const files = new Map<string, string>();
  for (const [file, hash] of Object.entries(raw.files)) {
    if (Predicate.isString(hash) && isSafeRelative(file)) files.set(file, hash);
  }
  return { files };
}

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
    /** Write changed files, delete stale ones, update the manifest. */
    readonly write: (
      outputDir: string,
      files: readonly OutputFile[],
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

      const readManifest = Effect.fn("OutputWriter.readManifest")(function* (
        outputDir: string,
      ) {
        const text = yield* fs
          .readFileString(path.join(outputDir, MANIFEST_FILE))
          .pipe(Effect.option);
        return Option.isSome(text) ? parseManifest(text.value) : undefined;
      });

      const listFiles = Effect.fn("OutputWriter.listFiles")(function* (
        outputDir: string,
      ) {
        const entries = yield* fs
          .readDirectory(outputDir, { recursive: true })
          .pipe(Effect.orElseSucceed((): string[] => []));
        const files: string[] = [];
        for (const entry of entries) {
          const info = yield* fs
            .stat(path.join(outputDir, entry))
            .pipe(Effect.option);
          if (Option.isSome(info) && info.value.type === "File") {
            files.push(entry.split(path.sep).join("/"));
          }
        }
        return files;
      });

      /** Files of a folder written by an older Anhur (no manifest yet). */
      const adoptLegacy = Effect.fn("OutputWriter.adoptLegacy")(function* (
        outputDir: string,
      ) {
        const index = yield* fs
          .readFileString(path.join(outputDir, "index.js"))
          .pipe(Effect.option);
        if (
          Option.isNone(index) ||
          !index.value.startsWith("// generated by @anhur/core")
        ) {
          return undefined;
        }
        const files = yield* listFiles(outputDir);
        if (
          !files.every(
            (file) =>
              /\.(?:js|d\.ts|json)$/.test(file) || file.endsWith(".keep"),
          )
        ) {
          return undefined;
        }
        return { files: new Map(files.map((file) => [file, ""] as const)) };
      });

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
          if (yield* readManifest(outputDir)) return;
          const entries = yield* fs
            .readDirectory(outputDir)
            .pipe(Effect.orElseSucceed((): string[] => []));
          if (entries.length === 0) return;
          if (yield* adoptLegacy(outputDir)) return;
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

      const writeAtomic = Effect.fn("OutputWriter.writeAtomic")(function* (
        target: string,
        contents: string,
      ) {
        const temporary = path.join(
          path.dirname(target),
          `.${path.basename(target)}.${randomUUID().slice(0, 8)}.tmp`,
        );
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(temporary, contents);
        yield* fs.rename(temporary, target).pipe(
          Effect.tapError(() =>
            fs.remove(temporary, { force: true }).pipe(
              Effect.ignore({
                log: "Warn",
                message: "Removing a temporary output file failed",
              }),
            ),
          ),
        );
      });

      const removeEmptyParents = Effect.fn("OutputWriter.removeEmptyParents")(
        function* (outputDir: string, file: string) {
          let dir = path.dirname(file);
          while (dir.startsWith(outputDir + path.sep)) {
            const entries = yield* fs
              .readDirectory(dir)
              .pipe(Effect.orElseSucceed(() => ["?"]));
            if (entries.length > 0) return;
            yield* fs.remove(dir).pipe(
              Effect.ignore({
                log: "Warn",
                message: "Removing an empty output folder failed",
              }),
            );
            dir = path.dirname(dir);
          }
        },
      );

      const write = Effect.fn("OutputWriter.write")(function* (
        outputDir: string,
        files: readonly OutputFile[],
      ) {
        const previous =
          (yield* readManifest(outputDir)) ?? (yield* adoptLegacy(outputDir));
        const previousFiles = previous?.files ?? new Map<string, string>();
        const ordered = [...files].sort((a, b) => {
          const rank = (file: OutputFile) =>
            file.path === "index.js" ? 2 : file.path === "index.d.ts" ? 1 : 0;
          return rank(a) - rank(b);
        });
        const next = new Map<string, string>();
        for (const file of ordered) {
          if (!isSafeRelative(file.path) || file.path === MANIFEST_FILE) {
            return yield* Effect.fail(
              failed(
                `Refusing to write the unsafe output path "${file.path}".`,
              ),
            );
          }
          next.set(file.path, contentHash(file.contents));
        }
        const targetOf = (file: string) =>
          path.join(outputDir, ...file.split("/"));
        const writeManifest = (entries: ReadonlyMap<string, string>) =>
          writeAtomic(
            path.join(outputDir, MANIFEST_FILE),
            `${JSON.stringify(
              {
                version: MANIFEST_VERSION,
                generator: GENERATED_HEADER,
                files: Object.fromEntries(
                  [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
                ),
              },
              null,
              2,
            )}\n`,
          ).pipe(
            Effect.mapError((error) =>
              failed(`Could not write the output manifest: ${error.message}`),
            ),
          );

        // Record new files before creating them, so an interrupted build
        // never leaves files that later builds would not clean up.
        if ([...next.keys()].some((file) => !previousFiles.has(file))) {
          yield* writeManifest(new Map([...previousFiles, ...next]));
        }

        const removed: string[] = [];
        const removeStale = Effect.fn("OutputWriter.removeStale")(function* (
          file: string,
        ) {
          const target = targetOf(file);
          yield* fs.remove(target, { force: true }).pipe(
            Effect.ignore({
              log: "Warn",
              message: "Removing a stale output file failed",
            }),
          );
          removed.push(target);
          yield* removeEmptyParents(outputDir, target);
        });

        // A case-only rename (getBlogPost.js → getBlogpost.js) is one file on
        // case-insensitive file systems: remove the old name before writing
        // the new one, never after.
        const nextByLowerCase = new Map(
          [...next.keys()].map((file) => [file.toLowerCase(), file]),
        );
        const renamed = new Set<string>();
        for (const file of previousFiles.keys()) {
          if (next.has(file)) continue;
          const replacement = nextByLowerCase.get(file.toLowerCase());
          if (replacement === undefined) continue;
          renamed.add(file);
          yield* removeStale(file);
        }

        const written: string[] = [];
        for (const file of ordered) {
          const target = targetOf(file.path);
          const info = yield* fs.stat(target).pipe(Effect.option);
          // Unchanged plan and the file still has the written size: keep it
          // (a size change means it was edited or truncated by hand).
          if (
            previousFiles.get(file.path) === next.get(file.path) &&
            Option.isSome(info) &&
            info.value.type === "File" &&
            Number(info.value.size) === Buffer.byteLength(file.contents)
          ) {
            continue;
          }
          yield* writeAtomic(target, file.contents).pipe(
            Effect.mapError((error) =>
              failed(`Could not write ${target}: ${error.message}`),
            ),
          );
          written.push(target);
        }
        for (const file of previousFiles.keys()) {
          if (next.has(file) || renamed.has(file)) continue;
          yield* removeStale(file);
        }
        yield* writeManifest(next);
        return { written, removed };
      });

      return OutputWriter.of({ lock, checkOwnership, write });
    }),
  );
}
