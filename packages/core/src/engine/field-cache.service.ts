import { randomUUID } from "node:crypto";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
} from "effect";
import nodePath from "node:path";
import type { DocumentValue } from "../document";
import type { BuildMode } from "../plugin/types";
import { decodeCacheValue, encodeCacheValue } from "./cache-codec";
import type { FileSignature } from "./file-signature";

/** An asset a cached value referenced, with the hash it had then. */
export type CachedAsset = {
  readonly sourcePath: string;
  readonly hash: string;
};

/**
 * A file a cached value read, with what `stat` said about it then (`-1`
 * everywhere: the file did not exist).
 */
export type CachedDependency = {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly ctimeMs: number;
  readonly ino: number;
};

/** One cached compiled field. */
export type CachedField = {
  readonly value: DocumentValue;
  readonly assets: readonly CachedAsset[];
  readonly dependencies: readonly CachedDependency[];
  /** `context.warn()` messages of the compile, replayed on a hit. */
  readonly warnings: readonly string[];
};

const FORMAT_VERSION = 3;

function isCachedAsset(value: unknown): value is CachedAsset {
  return (
    Predicate.isObject(value) &&
    "sourcePath" in value &&
    Predicate.isString(value.sourcePath) &&
    "hash" in value &&
    Predicate.isString(value.hash)
  );
}

export function isCachedDependency(value: unknown): value is CachedDependency {
  return (
    Predicate.isObject(value) &&
    "path" in value &&
    Predicate.isString(value.path) &&
    "mtimeMs" in value &&
    Predicate.isNumber(value.mtimeMs) &&
    "size" in value &&
    Predicate.isNumber(value.size) &&
    "ctimeMs" in value &&
    Predicate.isNumber(value.ctimeMs) &&
    "ino" in value &&
    Predicate.isNumber(value.ino)
  );
}

/** What a file a cached value read looks like now. */
export function dependencyOf(
  file: string,
  signature: FileSignature | undefined,
): CachedDependency {
  return signature
    ? {
        path: file,
        mtimeMs: signature.mtimeMs,
        size: signature.size,
        ctimeMs: signature.ctimeMs,
        ino: signature.ino,
      }
    : { path: file, mtimeMs: -1, size: -1, ctimeMs: -1, ino: -1 };
}

/** True when `now` is the state `then` recorded: size, times and inode. */
export function sameDependency(
  then: CachedDependency,
  now: CachedDependency,
): boolean {
  return (
    then.size === now.size &&
    then.mtimeMs === now.mtimeMs &&
    then.ctimeMs === now.ctimeMs &&
    then.ino === now.ino
  );
}

function parseEntry(text: string): CachedField | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !Predicate.isObject(raw) ||
    !("version" in raw) ||
    raw.version !== FORMAT_VERSION ||
    !("assets" in raw) ||
    !Array.isArray(raw.assets) ||
    !raw.assets.every(isCachedAsset) ||
    !("dependencies" in raw) ||
    !Array.isArray(raw.dependencies) ||
    !raw.dependencies.every(isCachedDependency) ||
    !("warnings" in raw) ||
    !Array.isArray(raw.warnings) ||
    !raw.warnings.every(Predicate.isString) ||
    !("value" in raw)
  ) {
    return undefined;
  }
  let value: DocumentValue;
  try {
    value = decodeCacheValue(raw.value);
  } catch {
    // A damaged entry (for example a number that is not one): not cached.
    return undefined;
  }
  return {
    value,
    assets: raw.assets,
    dependencies: raw.dependencies,
    warnings: raw.warnings,
  };
}

const KEY = /^[0-9a-f]{64}$/;
/** Files this cache writes: entries and interrupted temporary writes. Nothing else is ever deleted. */
const OWNED_FILE =
  /^(?:[0-9a-f]{64}\.json|\.[0-9a-f]{64}\.\d+(?:\.[0-9a-f]{8})?\.tmp)$/;

/**
 * Folder of the compiled fields of one build mode. The keys of `dev` and
 * `build` differ, so each mode has a folder: cleaning up after one does not
 * remove what the other needs.
 */
export function fieldCacheDir(cacheDir: string, mode: BuildMode): string {
  return nodePath.join(cacheDir, "fields", mode);
}

/**
 * On-disk cache of compiled fields (`<cacheDir>/fields/<mode>/<key>.json`,
 * see {@link fieldCacheDir}; every method takes that folder). Writes are
 * atomic; entries no build used are deleted by `collect`.
 */
export class FieldCache extends Context.Service<
  FieldCache,
  {
    readonly read: (
      dir: string,
      key: string,
    ) => Effect.Effect<Option.Option<CachedField>>;
    readonly write: (
      dir: string,
      key: string,
      entry: CachedField,
    ) => Effect.Effect<void>;
    /**
     * Delete entries whose key is not in `keep`, and the entries an older
     * version left in the parent folder (it had one folder for every mode).
     */
    readonly collect: (
      dir: string,
      keep: ReadonlySet<string>,
    ) => Effect.Effect<void>;
  }
>()("@anhur/core/engine/FieldCache") {
  static readonly layer = Layer.effect(
    FieldCache,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const read = Effect.fn("FieldCache.read")(function* (
        dir: string,
        key: string,
      ) {
        if (!KEY.test(key)) return Option.none();
        const file = path.join(dir, `${key}.json`);
        const text = yield* fs
          .readFileString(file)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (text === undefined) return Option.none();
        // A damaged entry is left alone here (`anhur check` must not change
        // the disk): the compile that follows writes it again.
        const entry = parseEntry(text);
        return entry ? Option.some(entry) : Option.none();
      });

      const write = Effect.fn("FieldCache.write")(function* (
        dir: string,
        key: string,
        entry: CachedField,
      ) {
        if (!KEY.test(key)) return;
        const target = path.join(dir, `${key}.json`);
        // Two documents with the same field value write the same key at
        // once: each write needs its own temporary file.
        const temporary = path.join(
          dir,
          `.${key}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
        );
        const body = JSON.stringify({
          version: FORMAT_VERSION,
          value: encodeCacheValue(entry.value),
          assets: entry.assets,
          dependencies: entry.dependencies,
          warnings: entry.warnings,
        });
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(
          Effect.andThen(fs.writeFileString(temporary, body)),
          Effect.andThen(fs.rename(temporary, target)),
          Effect.ignore({
            log: "Warn",
            message: "Writing a field cache entry failed",
          }),
        );
      });

      /** Delete the files of this cache in `dir` whose key is not in `keep`. */
      const sweep = Effect.fn("FieldCache.sweep")(function* (
        dir: string,
        keep: ReadonlySet<string>,
      ) {
        const names = yield* fs
          .readDirectory(dir)
          .pipe(Effect.orElseSucceed((): string[] => []));
        const stale = names.filter((name) => {
          if (!OWNED_FILE.test(name)) return false;
          const key = name.endsWith(".json") ? name.slice(0, -5) : "";
          return !keep.has(key);
        });
        yield* Effect.forEach(
          stale,
          (name) =>
            fs.remove(path.join(dir, name), { force: true }).pipe(
              Effect.ignore({
                log: "Warn",
                message: "Removing a stale cache entry failed",
              }),
            ),
          { concurrency: 8, discard: true },
        );
      });

      const collect = Effect.fn("FieldCache.collect")(function* (
        dir: string,
        keep: ReadonlySet<string>,
      ) {
        yield* sweep(dir, keep);
        yield* sweep(path.dirname(dir), new Set());
      });

      return FieldCache.of({ read, write, collect });
    }),
  );
}
