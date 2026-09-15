import { Predicate } from "effect";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ASSETS_PROCESSOR_ID,
  type AssetStorageClient,
  type AssetsProcessorOptions,
  type AssetsStorageOptions,
  type BuildContext,
} from "./build-context";
import { findProcessor } from "./processors";

const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";
const DEFAULT_CONCURRENCY = 8;

export type AssetsStorageSyncResult = {
  uploaded: string[];
  skipped: string[];
  deleted: string[];
  dryRun: boolean;
  /** Set when prune was skipped because this build emitted no assets. */
  pruneSkipped?: "empty-emit";
};

const DEFAULT_KEYS_SHOWN = 40;

function formatKeyList(
  label: string,
  keys: readonly string[],
  maxShown: number,
): string | undefined {
  if (keys.length === 0) return undefined;
  const shown = keys.slice(0, maxShown);
  const rest = keys.length - shown.length;
  const list =
    rest > 0 ? `${shown.join(", ")} … +${rest} more` : shown.join(", ");
  return `${label} (${keys.length}): ${list}`;
}

/**
 * Human-readable lines for a storage sync result (Vite / CLI).
 * Summary first, then truncated key lists for uploaded / skipped / deleted.
 */
export function formatAssetsStorageLogLines(
  storage: AssetsStorageSyncResult,
  options: { maxKeys?: number; prefix?: string } = {},
): string[] {
  const maxKeys = options.maxKeys ?? DEFAULT_KEYS_SHOWN;
  const linePrefix = options.prefix ?? "[anhur]   ";

  const parts = [
    `${storage.uploaded.length} uploaded`,
    `${storage.skipped.length} skipped`,
    `${storage.deleted.length} deleted`,
  ];
  if (storage.dryRun) parts.push("dry-run");
  if (storage.pruneSkipped === "empty-emit") {
    parts.push("prune skipped (no assets emitted)");
  }

  const lines = [`${linePrefix}assets storage: ${parts.join(", ")}`];

  const uploaded = formatKeyList("uploaded", storage.uploaded, maxKeys);
  const skipped = formatKeyList("skipped", storage.skipped, maxKeys);
  const deleted = formatKeyList("deleted", storage.deleted, maxKeys);
  if (uploaded) lines.push(`${linePrefix}  ${uploaded}`);
  if (skipped) lines.push(`${linePrefix}  ${skipped}`);
  if (deleted) lines.push(`${linePrefix}  ${deleted}`);

  return lines;
}

type DeleteManyResultLike = {
  deleted?: string[];
  errors?: Array<{ key: string; error: unknown }>;
};

function isDeleteManyResultLike(value: unknown): value is DeleteManyResultLike {
  return Predicate.isObject(value) && !Array.isArray(value);
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error(
      'assets({ storage }) requires a non-empty prefix (e.g. "anhur").',
    );
  }
  return `${trimmed}/`;
}

function isAbsoluteHttpUrl(base: string): boolean {
  return /^https?:\/\//i.test(base);
}

function resolveStorageOptions(
  ctx: BuildContext,
): AssetsStorageOptions | undefined {
  const plugin = findProcessor(ctx.processors, ASSETS_PROCESSOR_ID);
  if (!plugin) return undefined;
  // SAFETY: preserves the existing runtime contract for this assignment.
  const options = (plugin.options ?? {}) as AssetsProcessorOptions;
  return options.storage;
}

async function resolveFilesClient(
  storage: Extract<AssetsStorageOptions, { enabled: true }>,
): Promise<AssetStorageClient> {
  const value = Predicate.isFunction(storage.files)
    ? await storage.files()
    : storage.files;
  if (
    !value ||
    !Predicate.isFunction(value.upload) ||
    !Predicate.isFunction(value.exists) ||
    !Predicate.isFunction(value.delete) ||
    !Predicate.isFunction(value.listAll)
  ) {
    throw new Error(
      "assets({ storage.files }) must be a files-sdk Files instance (or factory) with upload, exists, delete, and listAll.",
    );
  }
  return value;
}

async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, concurrency);
  let next = 0;
  let failed: unknown;

  async function run(): Promise<void> {
    while (next < items.length) {
      if (failed) return;
      const index = next;
      next += 1;
      try {
        await worker(items[index]!);
      } catch (cause) {
        failed = cause;
        return;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run()),
  );
  if (failed) throw failed;
}

async function deleteOrphans(
  files: AssetStorageClient,
  orphans: string[],
): Promise<string[]> {
  // SAFETY: files-sdk bulk delete returns void or { deleted, errors }.
  const result = (await files.delete(orphans)) as
    | void
    | DeleteManyResultLike
    | undefined;

  if (isDeleteManyResultLike(result)) {
    if (result.errors && result.errors.length > 0) {
      const detail = result.errors
        .slice(0, 5)
        .map((entry) => {
          const message =
            entry.error instanceof Error
              ? entry.error.message
              : String(entry.error);
          return `${entry.key}: ${message}`;
        })
        .join("; ");
      const more =
        result.errors.length > 5 ? ` (+${result.errors.length - 5} more)` : "";
      throw new Error(
        `failed to delete ${result.errors.length} remote asset(s): ${detail}${more}`,
      );
    }
    return result.deleted ?? orphans;
  }

  return orphans;
}

/**
 * Upload emitted assets to remote storage and optionally prune orphans.
 * No-op when `storage` is missing or `enabled` is false.
 * Safe to call only after a successful build emit pass.
 *
 * Prune never runs when this build emitted zero assets unless
 * `storage.pruneEmpty` is true — otherwise an empty keep-set would delete
 * every object under the prefix.
 */
export async function syncEmittedAssetsStorage(
  ctx: BuildContext,
): Promise<AssetsStorageSyncResult | undefined> {
  const storage = resolveStorageOptions(ctx);
  if (!storage || !storage.enabled) return undefined;
  if (!ctx.assets) {
    throw new Error(
      "assets storage sync requires an assets() processor with a resolved assets directory.",
    );
  }
  if (!isAbsoluteHttpUrl(ctx.assets.configuredBase)) {
    throw new Error(
      `assets({ storage.enabled: true }) requires base to be an absolute http(s) URL (got "${ctx.assets.configuredBase}").`,
    );
  }

  const prefix = normalizePrefix(storage.prefix);
  const files = await resolveFilesClient(storage);
  const dryRun = storage.dryRun === true;
  const prune = storage.prune !== false;
  const pruneEmpty = storage.pruneEmpty === true;
  const concurrency = storage.concurrency ?? DEFAULT_CONCURRENCY;
  const cacheControl = storage.cacheControl ?? DEFAULT_CACHE_CONTROL;

  const emitted = ctx.getEmittedAssets();
  const keepKeys = new Set(
    emitted.map((asset) => `${prefix}${path.basename(asset.outputPath)}`),
  );

  const uploaded: string[] = [];
  const skipped: string[] = [];

  await mapPool(emitted, concurrency, async (asset) => {
    const key = `${prefix}${path.basename(asset.outputPath)}`;
    const already = await files.exists(key);
    if (already) {
      skipped.push(key);
      return;
    }
    if (dryRun) {
      uploaded.push(key);
      return;
    }
    const body = await readFile(asset.outputPath);
    await files.upload(key, body, { cacheControl });
    uploaded.push(key);
  });

  const deleted: string[] = [];
  let pruneSkipped: AssetsStorageSyncResult["pruneSkipped"];

  if (prune) {
    if (emitted.length === 0 && !pruneEmpty) {
      pruneSkipped = "empty-emit";
    } else {
      const remoteKeys: string[] = [];
      for await (const item of files.listAll({ prefix })) {
        remoteKeys.push(item.key);
      }

      const orphans = remoteKeys.filter((key) => !keepKeys.has(key));
      if (orphans.length > 0) {
        if (!dryRun) {
          deleted.push(...(await deleteOrphans(files, orphans)));
        } else {
          deleted.push(...orphans);
        }
      }
    }
  }

  return { uploaded, skipped, deleted, dryRun, pruneSkipped };
}
