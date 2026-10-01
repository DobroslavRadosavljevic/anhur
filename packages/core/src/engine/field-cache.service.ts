import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
} from "effect";
import type { DocumentValue } from "../document";
import { decodeCacheValue, encodeCacheValue } from "./cache-codec";

/** An asset a cached value referenced, with the hash it had then. */
export type CachedAsset = {
  readonly sourcePath: string;
  readonly hash: string;
};

/** A file a cached value read, with its size and mtime then. */
export type CachedDependency = {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
};

/** One cached compiled field. */
export type CachedField = {
  readonly value: DocumentValue;
  readonly assets: readonly CachedAsset[];
  readonly dependencies: readonly CachedDependency[];
  /** `context.warn()` messages of the compile, replayed on a hit. */
  readonly warnings: readonly string[];
};

const FORMAT_VERSION = 2;

function isCachedAsset(value: unknown): value is CachedAsset {
  return (
    Predicate.isObject(value) &&
    "sourcePath" in value &&
    Predicate.isString(value.sourcePath) &&
    "hash" in value &&
    Predicate.isString(value.hash)
  );
}

function isCachedDependency(value: unknown): value is CachedDependency {
  return (
    Predicate.isObject(value) &&
    "path" in value &&
    Predicate.isString(value.path) &&
    "mtimeMs" in value &&
    Predicate.isNumber(value.mtimeMs) &&
    "size" in value &&
    Predicate.isNumber(value.size)
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
  return {
    value: decodeCacheValue(raw.value),
    assets: raw.assets,
    dependencies: raw.dependencies,
    warnings: raw.warnings,
  };
}

const KEY = /^[0-9a-f]{64}$/;
/** Files this cache writes: entries and interrupted temporary writes. Nothing else is ever deleted. */
const OWNED_FILE = /^(?:[0-9a-f]{64}\.json|\.[0-9a-f]{64}\.\d+\.tmp)$/;

/**
 * On-disk cache of compiled fields (`<cacheDir>/fields/<key>.json`). Writes
 * are atomic; entries no build used are deleted by `collect`.
 */
export class FieldCache extends Context.Service<
  FieldCache,
  {
    readonly read: (
      cacheDir: string,
      key: string,
    ) => Effect.Effect<Option.Option<CachedField>>;
    readonly write: (
      cacheDir: string,
      key: string,
      entry: CachedField,
    ) => Effect.Effect<void>;
    /** Delete entries whose key is not in `keep`. */
    readonly collect: (
      cacheDir: string,
      keep: ReadonlySet<string>,
    ) => Effect.Effect<void>;
  }
>()("@anhur/core/engine/FieldCache") {
  static readonly layer = Layer.effect(
    FieldCache,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = (cacheDir: string) => path.join(cacheDir, "fields");

      const read = Effect.fn("FieldCache.read")(function* (
        cacheDir: string,
        key: string,
      ) {
        if (!KEY.test(key)) return Option.none();
        const file = path.join(folder(cacheDir), `${key}.json`);
        const text = yield* fs
          .readFileString(file)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (text === undefined) return Option.none();
        const entry = parseEntry(text);
        if (!entry) {
          yield* fs.remove(file, { force: true }).pipe(
            Effect.ignore({
              log: "Warn",
              message: "Removing a corrupt cache entry failed",
            }),
          );
          return Option.none();
        }
        return Option.some(entry);
      });

      const write = Effect.fn("FieldCache.write")(function* (
        cacheDir: string,
        key: string,
        entry: CachedField,
      ) {
        if (!KEY.test(key)) return;
        const dir = folder(cacheDir);
        const target = path.join(dir, `${key}.json`);
        const temporary = path.join(dir, `.${key}.${process.pid}.tmp`);
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

      const collect = Effect.fn("FieldCache.collect")(function* (
        cacheDir: string,
        keep: ReadonlySet<string>,
      ) {
        const dir = folder(cacheDir);
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

      return FieldCache.of({ read, write, collect });
    }),
  );
}
