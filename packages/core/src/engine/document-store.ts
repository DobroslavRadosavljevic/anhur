import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Predicate } from "effect";
import { isPlainObject, type DocumentFields } from "../document";
import type { AssetRef } from "../plugin/types";
import { decodeCacheValue, encodeCacheValue } from "./cache-codec";
import type { CachedDependency } from "./field-cache.service";
import { mapPool, type FileSignature } from "./file-signature";

/**
 * A validated document kept on disk between runs
 * (`<cacheDir>/documents/<key>.json`), so a later session does not load,
 * compile and validate files that did not change.
 */
export type StoredDocument = {
  /** Everything besides the file content the document depends on. */
  readonly stamp: string;
  /** SHA-256 of the raw file text. */
  readonly hash: string;
  /** Signature of the file when it was read. */
  readonly signature: FileSignature;
  /** Epoch milliseconds, taken before the file was read. */
  readonly readAt: number;
  readonly draft: boolean;
  readonly data: DocumentFields;
  readonly assets: readonly AssetRef[];
  /** Files reported through `addDependency`. */
  readonly dependencies: readonly string[];
  /** Size and mtime of `dependencies` and of the asset sources. */
  readonly watched: readonly CachedDependency[];
  /** Field cache entries the document used. */
  readonly cacheKeys: readonly string[];
  /** `context.warn()` messages. */
  readonly warnings: readonly string[];
};

const FORMAT_VERSION = 1;
const KEY = /^[0-9a-f]{40}$/;
/** Files this store writes: entries and interrupted temporary writes. */
const OWNED_FILE =
  /^(?:[0-9a-f]{40}\.json|\.[0-9a-f]{40}\.\d+\.[0-9a-f]{8}\.tmp)$/;
const REMOVE_CONCURRENCY = 16;

/** Folder of the store inside the cache directory. */
export function documentStoreDir(cacheDir: string): string {
  return path.join(cacheDir, "documents");
}

/** Key of a document: its source and its path in the project. */
export function storedDocumentKey(source: string, filePath: string): string {
  return createHash("sha256")
    .update(`${source}\u0000${filePath}`)
    .digest("hex")
    .slice(0, 40);
}

function isSignature(value: unknown): value is FileSignature {
  return (
    Predicate.isObject(value) &&
    "size" in value &&
    Predicate.isNumber(value.size) &&
    "mtimeMs" in value &&
    Predicate.isNumber(value.mtimeMs) &&
    "ctimeMs" in value &&
    Predicate.isNumber(value.ctimeMs) &&
    "ino" in value &&
    Predicate.isNumber(value.ino) &&
    "isFile" in value &&
    Predicate.isBoolean(value.isFile)
  );
}

function isAssetRef(value: unknown): value is AssetRef {
  return (
    Predicate.isObject(value) &&
    "src" in value &&
    Predicate.isString(value.src) &&
    "sourcePath" in value &&
    Predicate.isString(value.sourcePath) &&
    "fileName" in value &&
    Predicate.isString(value.fileName) &&
    "hash" in value &&
    Predicate.isString(value.hash) &&
    "size" in value &&
    Predicate.isNumber(value.size) &&
    "contentType" in value &&
    Predicate.isString(value.contentType)
  );
}

function isWatched(value: unknown): value is CachedDependency {
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

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(Predicate.isString);
}

function parseStored(text: string): StoredDocument | undefined {
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
    !("stamp" in raw) ||
    !Predicate.isString(raw.stamp) ||
    !("hash" in raw) ||
    !Predicate.isString(raw.hash) ||
    !("signature" in raw) ||
    !isSignature(raw.signature) ||
    !("readAt" in raw) ||
    !Predicate.isNumber(raw.readAt) ||
    !("draft" in raw) ||
    !Predicate.isBoolean(raw.draft) ||
    !("assets" in raw) ||
    !Array.isArray(raw.assets) ||
    !raw.assets.every(isAssetRef) ||
    !("dependencies" in raw) ||
    !isStringList(raw.dependencies) ||
    !("watched" in raw) ||
    !Array.isArray(raw.watched) ||
    !raw.watched.every(isWatched) ||
    !("cacheKeys" in raw) ||
    !isStringList(raw.cacheKeys) ||
    !("warnings" in raw) ||
    !isStringList(raw.warnings) ||
    !("data" in raw)
  ) {
    return undefined;
  }
  const data = decodeCacheValue(raw.data);
  if (!isPlainObject(data)) return undefined;
  return {
    stamp: raw.stamp,
    hash: raw.hash,
    signature: raw.signature,
    readAt: raw.readAt,
    draft: raw.draft,
    data,
    assets: raw.assets,
    dependencies: raw.dependencies,
    watched: raw.watched,
    cacheKeys: raw.cacheKeys,
    warnings: raw.warnings,
  };
}

/** The stored document of `key`, or `undefined` when there is none (or it is unreadable). */
export async function readStoredDocument(
  cacheDir: string,
  key: string,
): Promise<StoredDocument | undefined> {
  if (!KEY.test(key)) return undefined;
  let text: string;
  try {
    text = await readFile(
      path.join(documentStoreDir(cacheDir), `${key}.json`),
      "utf8",
    );
  } catch {
    return undefined;
  }
  return parseStored(text);
}

/**
 * Write a document atomically. The folder must exist. A failed write only
 * costs the next session a rebuild of the document, so it is not an error.
 */
export async function writeStoredDocument(
  cacheDir: string,
  key: string,
  entry: StoredDocument,
): Promise<void> {
  if (!KEY.test(key)) return;
  const dir = documentStoreDir(cacheDir);
  const temporary = path.join(
    dir,
    `.${key}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  );
  const body = JSON.stringify({
    version: FORMAT_VERSION,
    stamp: entry.stamp,
    hash: entry.hash,
    signature: entry.signature,
    readAt: entry.readAt,
    draft: entry.draft,
    data: encodeCacheValue(entry.data),
    assets: entry.assets,
    dependencies: entry.dependencies,
    watched: entry.watched,
    cacheKeys: entry.cacheKeys,
    warnings: entry.warnings,
  });
  try {
    await writeFile(temporary, body);
    await rename(temporary, path.join(dir, `${key}.json`));
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Create the store folder (before the first write of a build). */
export async function prepareDocumentStore(cacheDir: string): Promise<void> {
  await mkdir(documentStoreDir(cacheDir), { recursive: true });
}

/** Delete stored documents whose key is not in `keep`. Only files this store wrote are removed. */
export async function collectStoredDocuments(
  cacheDir: string,
  keep: ReadonlySet<string>,
): Promise<void> {
  const dir = documentStoreDir(cacheDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const stale = names.filter((name) => {
    if (!OWNED_FILE.test(name)) return false;
    return !name.endsWith(".json") || !keep.has(name.slice(0, -5));
  });
  await mapPool(stale, REMOVE_CONCURRENCY, async (name) => {
    await rm(path.join(dir, name), { force: true }).catch(() => undefined);
  });
}
