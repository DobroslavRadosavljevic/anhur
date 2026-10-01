import { openAsBlob } from "node:fs";
import path from "node:path";
import type { AssetRef } from "@anhur/core/plugin";
import { checkConcurrency, runPool } from "./copy";
import { isHashedAssetName } from "./hashed-names";

/** What files-sdk methods resolve to (results are only inspected for delete errors). */
export type StorageCallResult = object | void | null | undefined;

/** The part of a files-sdk `Files` client Anhur uses. */
export type AssetStorageClient = {
  /** `body` is a file-backed Blob: files are streamed, never read whole. */
  upload(
    key: string,
    body: Blob,
    options?: { readonly cacheControl?: string; readonly contentType?: string },
  ): Promise<StorageCallResult>;
  exists(key: string): Promise<boolean>;
  delete(keys: string | string[]): Promise<StorageCallResult>;
  listAll(options?: {
    readonly prefix?: string;
  }): AsyncIterable<{ readonly key: string }>;
};

/** Upload copied assets to S3-compatible storage through files-sdk. */
export type AssetsStorageOptions = {
  /** files-sdk `Files` client, or a factory (only called when a sync runs). */
  readonly files:
    | AssetStorageClient
    | (() => AssetStorageClient | Promise<AssetStorageClient>);
  /**
   * Key prefix (`"site"` → `site/cover-1a2b….png`). `assets({ base })` must
   * be the public URL of this prefix.
   */
  readonly prefix: string;
  /**
   * After a successful `build`, delete content-hashed objects directly under
   * the prefix (`site/<name>-<16 hex>.<ext>`) that this build does not use.
   * Other keys (sub-folders, other names) are never touched, and dev
   * sessions never prune. Off by default: another deployment (preview,
   * rollback) that shares the prefix may still need older files.
   */
  readonly prune?: boolean;
  /** Allow pruning when this build has no assets (deletes the whole prefix). Default `false`. */
  readonly pruneEmpty?: boolean;
  /** Report what would change without uploading or deleting. */
  readonly dryRun?: boolean;
  /** Parallel uploads: a whole number of at least 1. Default `8`. */
  readonly concurrency?: number;
  /** Default `public, max-age=31536000, immutable` (names are content-hashed). */
  readonly cacheControl?: string;
  /** Also sync in dev mode (watch / dev server). Default `false`. */
  readonly syncInDev?: boolean;
};

export type StorageResult = {
  readonly uploaded: number;
  readonly skipped: number;
  readonly dryRun: boolean;
};

export type StoragePruneResult = {
  readonly deleted: number;
  readonly dryRun: boolean;
};

const DELETE_BATCH = 1000;

/** `site/` → `site/`, `/site` → `site/`. */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  return trimmed.length === 0 ? "" : `${trimmed}/`;
}

function isClient(value: unknown): value is AssetStorageClient {
  return (
    value !== null &&
    typeof value === "object" &&
    "upload" in value &&
    typeof value.upload === "function" &&
    "exists" in value &&
    typeof value.exists === "function" &&
    "delete" in value &&
    typeof value.delete === "function" &&
    "listAll" in value &&
    typeof value.listAll === "function"
  );
}

function isFactory(
  value: AssetsStorageOptions["files"],
): value is () => AssetStorageClient | Promise<AssetStorageClient> {
  return typeof value === "function";
}

async function resolveClient(
  options: AssetsStorageOptions,
): Promise<AssetStorageClient> {
  const value: unknown = isFactory(options.files)
    ? await options.files()
    : options.files;
  if (!isClient(value)) {
    throw new Error(
      "assets({ storage.files }) must be a files-sdk Files client (upload, exists, delete, listAll).",
    );
  }
  return value;
}

function hasErrors(
  value: unknown,
): value is { readonly errors: readonly unknown[] } {
  return (
    value !== null &&
    typeof value === "object" &&
    "errors" in value &&
    Array.isArray(value.errors)
  );
}

function hasKey(value: unknown): value is { readonly key: unknown } {
  return value !== null && typeof value === "object" && "key" in value;
}

/** Keys files-sdk reported as failed in a bulk delete result. */
function deleteErrors(value: unknown): string[] {
  if (!hasErrors(value)) return [];
  return value.errors.map((entry) =>
    hasKey(entry) ? String(entry.key) : String(entry),
  );
}

/**
 * Upload assets missing from storage, streamed from `assetsDir` with their
 * content type. Keys in `known` (already checked or uploaded by this
 * process) are skipped without a storage call; uploaded keys are added to
 * it. Stops starting uploads after the first failure.
 */
export async function syncStorage(
  options: AssetsStorageOptions,
  assetsDir: string,
  assets: readonly AssetRef[],
  known: Set<string> = new Set(),
): Promise<StorageResult> {
  const prefix = normalizePrefix(options.prefix);
  const concurrency = checkConcurrency(options.concurrency);
  const dryRun = options.dryRun === true;
  const cacheControl =
    options.cacheControl ?? "public, max-age=31536000, immutable";
  const pending = assets.filter(
    (asset) => !known.has(`${prefix}${asset.fileName}`),
  );
  let uploaded = 0;
  let skipped = assets.length - pending.length;
  if (pending.length === 0) return { uploaded, skipped, dryRun };
  const client = await resolveClient(options);
  await runPool(pending, concurrency, async (asset) => {
    const key = `${prefix}${asset.fileName}`;
    if (await client.exists(key)) {
      known.add(key);
      skipped += 1;
      return;
    }
    if (!dryRun) {
      const body = await openAsBlob(path.join(assetsDir, asset.fileName), {
        type: asset.contentType,
      });
      await client.upload(key, body, {
        cacheControl,
        contentType: asset.contentType,
      });
      known.add(key);
    }
    uploaded += 1;
  });
  return { uploaded, skipped, dryRun };
}

/**
 * With `prune: true`, delete content-hashed objects directly under the
 * prefix that `assets` does not use, in batches. Keys in sub-folders or
 * with other names are kept. Nothing is deleted for an empty asset list
 * unless `pruneEmpty`. Deleted keys are removed from `known`.
 */
export async function pruneStorage(
  options: AssetsStorageOptions,
  assets: readonly AssetRef[],
  known: Set<string> = new Set(),
): Promise<StoragePruneResult> {
  const dryRun = options.dryRun === true;
  if (
    options.prune !== true ||
    (assets.length === 0 && options.pruneEmpty !== true)
  ) {
    return { deleted: 0, dryRun };
  }
  const prefix = normalizePrefix(options.prefix);
  const client = await resolveClient(options);
  const keep = new Set(assets.map((asset) => asset.fileName));
  const stale: string[] = [];
  for await (const item of client.listAll({ prefix })) {
    if (!item.key.startsWith(prefix)) continue;
    const name = item.key.slice(prefix.length);
    if (keep.has(name) || !isHashedAssetName(name)) continue;
    stale.push(item.key);
  }
  let deleted = 0;
  for (let index = 0; index < stale.length; index += DELETE_BATCH) {
    const batch = stale.slice(index, index + DELETE_BATCH);
    if (!dryRun) {
      const failed = deleteErrors(await client.delete(batch));
      if (failed.length > 0) {
        throw new Error(
          `could not delete ${failed.length} stored asset(s): ${failed.slice(0, 5).join(", ")}`,
        );
      }
      for (const key of batch) known.delete(key);
    }
    deleted += batch.length;
  }
  return { deleted, dryRun };
}
