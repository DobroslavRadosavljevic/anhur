import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { AssetRef } from "@anhur/core/plugin";
import {
  hashAssetBytes,
  hashAssetFile,
  isHashedAssetName,
} from "./hashed-names";
import {
  MAX_SVG_BYTES,
  sanitizeSvg,
  svgTransformVersion,
  type SvgMode,
} from "./svg";

/** File that marks a folder as managed by `assets()` and lists the files it owns. */
export const ASSETS_MANIFEST = ".anhur-assets.json";

const DEFAULT_CONCURRENCY = 8;

type AssetsManifest = { readonly files: readonly string[] };

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isManifest(value: unknown): value is AssetsManifest {
  return (
    value !== null &&
    typeof value === "object" &&
    "files" in value &&
    Array.isArray(value.files) &&
    value.files.every(isString)
  );
}

function hasCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

/**
 * File names listed in the manifest of `dir`; `undefined` without a
 * (readable) manifest. Entries that are not content-hashed names (`..`,
 * `a/b`, `""`) are ignored, so a damaged manifest can never point outside
 * the folder.
 */
export async function readAssetsManifest(
  dir: string,
): Promise<readonly string[] | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(dir, ASSETS_MANIFEST), "utf8"));
  } catch {
    return undefined;
  }
  if (!isManifest(raw)) return undefined;
  return raw.files.filter((file) => isHashedAssetName(file));
}

declare const folderStateBrand: unique symbol;

/**
 * What a session knows about one assets folder between builds. Make it
 * with {@link createAssetsFolderState}, keep it for the session, and give
 * it to each {@link copyAssets} and {@link pruneAssets} call for that
 * folder. With it, a build does not read the folder again while the
 * folder is as the last build left it.
 *
 * The value is opaque: it has no fields to read or to set.
 */
export type AssetsFolderState = { readonly [folderStateBrand]: true };

/**
 * What a state holds: the assets that were in place after the last build
 * and the folder's mtime then. While both are the same, every file is
 * still there and nothing has to be copied, pruned or listed again.
 */
type FolderRecord = {
  assets: readonly AssetRef[] | undefined;
  mtimeMs: number | undefined;
  /** Epoch milliseconds when `mtimeMs` was read. */
  readAt: number;
};

/** The record of each state. A state is only the key of its record. */
const folderRecords = new WeakMap<AssetsFolderState, FolderRecord>();

/** A new state that knows nothing: the next build reads the folder. */
export function createAssetsFolderState(): AssetsFolderState {
  // SAFETY: the brand is a type-only mark; the object has no fields and is only a key of `folderRecords`.
  const state = Object.freeze({}) as AssetsFolderState;
  folderRecords.set(state, {
    assets: undefined,
    mtimeMs: undefined,
    readAt: 0,
  });
  return state;
}

/**
 * A folder changed twice within the time step of the file system keeps its
 * mtime the second time. An mtime only proves "unchanged" when it was this
 * much older than the moment it was read.
 */
const SETTLE_MS = 2500;

function sameAssets(
  left: readonly AssetRef[] | undefined,
  right: readonly AssetRef[],
): boolean {
  if (!left || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.fileName !== right[index]?.fileName) return false;
  }
  return true;
}

async function folderMtime(dir: string): Promise<number | undefined> {
  try {
    return (await stat(dir)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** True when `dir` holds exactly `assets`, as the last build left it. */
async function isSettled(
  record: FolderRecord | undefined,
  dir: string,
  assets: readonly AssetRef[],
): Promise<boolean> {
  if (!record || record.mtimeMs === undefined) return false;
  if (record.mtimeMs >= record.readAt - SETTLE_MS) return false;
  if (!sameAssets(record.assets, assets)) return false;
  return (await folderMtime(dir)) === record.mtimeMs;
}

async function listFiles(dir: string): Promise<string[] | undefined> {
  try {
    return await readdir(dir);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return undefined;
    throw cause;
  }
}

/** Files Anhur may delete in a folder, and whether a manifest lists them. */
type OwnedFiles = {
  readonly files: ReadonlySet<string>;
  readonly listed: boolean;
};

/**
 * Files Anhur may delete in `dir`: those in its manifest. A folder without
 * a manifest is only adopted when it is empty or every (non-dot) file is a
 * content-hashed name with an allowed extension (folders of older
 * versions). Throws otherwise, so user files are never removed.
 */
async function ownedFiles(
  dir: string,
  extensions: readonly string[] | undefined,
): Promise<OwnedFiles> {
  const manifest = await readAssetsManifest(dir);
  if (manifest) return { files: new Set(manifest), listed: true };
  const entries = (await listFiles(dir))?.filter(
    (entry) => !entry.startsWith("."),
  );
  if (!entries || entries.length === 0) {
    return { files: new Set(), listed: false };
  }
  if (entries.every((entry) => isHashedAssetName(entry, extensions))) {
    return { files: new Set(entries), listed: false };
  }
  throw new Error(
    `the assets folder "${dir}" has files Anhur did not create; refusing to manage it. Point assets({ dir }) at a dedicated folder.`,
  );
}

async function writeManifest(
  dir: string,
  files: Iterable<string>,
): Promise<void> {
  const manifest = JSON.stringify(
    { version: 1, files: [...new Set(files)].sort() },
    null,
    2,
  );
  const temporary = path.join(
    dir,
    `.${ASSETS_MANIFEST}.${randomUUID().slice(0, 8)}.tmp`,
  );
  await writeFile(temporary, `${manifest}\n`);
  await rename(temporary, path.join(dir, ASSETS_MANIFEST));
}

/** Parallel workers: an integer of at least 1. Throws otherwise. */
export function checkConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CONCURRENCY;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `concurrency must be a whole number of at least 1 (got ${String(value)}).`,
    );
  }
  return value;
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight. After the
 * first failure no new items start; the call waits for running ones and
 * rethrows that failure.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = checkConcurrency(concurrency);
  let next = 0;
  let failure: { readonly cause: unknown } | undefined;
  const run = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const index = next;
      next += 1;
      try {
        await worker(items[index]!);
      } catch (cause) {
        failure ??= { cause };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  if (failure) throw failure.cause;
}

function changedError(asset: AssetRef, actual: string): Error {
  return new Error(
    `"${asset.sourcePath}" changed while the build was running (expected hash ${asset.hash}, read ${actual}); run the build again.`,
  );
}

async function readSvgSource(asset: AssetRef): Promise<Buffer> {
  const info = await stat(asset.sourcePath);
  if (info.size > MAX_SVG_BYTES) {
    throw new Error(
      `"${asset.sourcePath}" is larger than ${MAX_SVG_BYTES / 1024 / 1024} MiB, too large to sanitize. Use assets({ svg: "keep" }) or a smaller SVG.`,
    );
  }
  return readFile(asset.sourcePath);
}

/**
 * Copy one asset to a temporary file next to `target` and check that the
 * bytes still have the hash in the asset's name, then move it in place.
 */
async function copyOne(
  asset: AssetRef,
  target: string,
  svg: SvgMode,
): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${asset.fileName}.${randomUUID().slice(0, 8)}.tmp`,
  );
  const version = svgTransformVersion(path.extname(asset.fileName), svg);
  try {
    if (version === undefined) {
      await copyFile(asset.sourcePath, temporary);
      const actual = await hashAssetFile(temporary, undefined);
      if (actual !== asset.hash) throw changedError(asset, actual);
    } else {
      const bytes = await readSvgSource(asset);
      const actual = hashAssetBytes(bytes, version);
      if (actual !== asset.hash) throw changedError(asset, actual);
      let clean: string;
      try {
        clean = sanitizeSvg(new TextDecoder().decode(bytes));
      } catch (cause) {
        throw new Error(
          `cannot sanitize "${asset.sourcePath}": ${cause instanceof Error ? cause.message : String(cause)} Fix the file or use assets({ svg: "keep" }).`,
          { cause },
        );
      }
      await writeFile(temporary, clean);
    }
    await rename(temporary, target);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
}

export type CopyOptions = {
  /** `sanitize` rebuilds SVGs from an allowlist; `keep` copies them as is. */
  readonly svg: SvgMode;
  /**
   * Allowed extensions. A folder without a manifest is only adopted when
   * every file has a hashed name with one of them.
   */
  readonly extensions?: readonly string[];
  /** Parallel copies. Default `8`. */
  readonly concurrency?: number;
};

export type CopyResult = {
  readonly copied: number;
};

export type PruneResult = {
  readonly removed: number;
};

function uniqueByName(assets: readonly AssetRef[]): AssetRef[] {
  const byName = new Map<string, AssetRef>();
  for (const asset of assets) {
    if (!isHashedAssetName(asset.fileName)) {
      throw new Error(
        `"${asset.fileName}" is not a content-hashed asset name; refusing to copy it.`,
      );
    }
    byName.set(asset.fileName, asset);
  }
  return [...byName.values()];
}

/**
 * Copy assets into `dir`. Names are content-hashed, so existing files are
 * skipped; new copies are checked against their hash (a source that
 * changed during the build fails it). The manifest then lists the files of
 * earlier builds plus the ones in place now — also when a copy failed — so
 * {@link pruneAssets} can remove every file Anhur wrote.
 *
 * With a `state` of the session (see {@link AssetsFolderState}), nothing is
 * read or copied while `assets` and the folder are as the last
 * {@link pruneAssets} call left them.
 */
export async function copyAssets(
  dir: string,
  assets: readonly AssetRef[],
  options: CopyOptions,
  state?: AssetsFolderState,
): Promise<CopyResult> {
  const folder = state && folderRecords.get(state);
  if (await isSettled(folder, dir, assets)) return { copied: 0 };
  if (folder) folder.mtimeMs = undefined;
  const owned = await ownedFiles(dir, options.extensions);
  const previous = owned.files;
  const unique = uniqueByName(assets);
  await mkdir(dir, { recursive: true });
  // One listing instead of a stat per asset.
  const onDisk = new Set(await listFiles(dir));
  const missing = unique.filter((asset) => !onDisk.has(asset.fileName));
  const present = new Set<string>();
  for (const asset of unique) {
    if (onDisk.has(asset.fileName)) present.add(asset.fileName);
  }
  const record = async (): Promise<void> => {
    // Unchanged when every file in place was already listed.
    let listed = true;
    for (const file of present) {
      if (!previous.has(file)) {
        listed = false;
        break;
      }
    }
    if (listed && owned.listed) return;
    await writeManifest(dir, [...previous, ...present]);
  };
  let copied = 0;
  try {
    await runPool(
      missing,
      checkConcurrency(options.concurrency),
      async (asset) => {
        await copyOne(asset, path.join(dir, asset.fileName), options.svg);
        copied += 1;
        present.add(asset.fileName);
      },
    );
  } catch (cause) {
    // The copy failure is the error to report; the manifest is best effort.
    await record().catch(() => undefined);
    throw cause;
  }
  await record();
  return { copied };
}

/**
 * Delete files of earlier builds that `assets` no longer uses (only names
 * in the manifest), then make the manifest list exactly `assets`. Run it
 * after the generated modules that point at the new files are published.
 *
 * With a `state` of the session (see {@link AssetsFolderState}), it writes
 * down how it left the folder, so later calls can skip an unchanged folder.
 */
export async function pruneAssets(
  dir: string,
  assets: readonly AssetRef[],
  options: { readonly extensions?: readonly string[] } = {},
  state?: AssetsFolderState,
): Promise<PruneResult> {
  const folder = state && folderRecords.get(state);
  if (await isSettled(folder, dir, assets)) return { removed: 0 };
  if (folder) folder.mtimeMs = undefined;
  const owned = await ownedFiles(dir, options.extensions);
  const previous = owned.files;
  const current = new Set(uniqueByName(assets).map((asset) => asset.fileName));
  let removed = 0;
  const kept = new Set([...previous, ...current]);
  try {
    for (const file of previous) {
      if (current.has(file)) continue;
      await rm(path.join(dir, file), { force: true });
      kept.delete(file);
      removed += 1;
    }
  } catch (cause) {
    // The delete failure is the error to report; the manifest is best effort.
    await writeManifest(dir, kept).catch(() => undefined);
    throw cause;
  }
  await mkdir(dir, { recursive: true });
  const unchanged =
    removed === 0 && kept.size === previous.size && owned.listed;
  if (!unchanged) await writeManifest(dir, kept);
  if (folder) {
    folder.assets = [...assets];
    folder.readAt = Date.now();
    folder.mtimeMs = await folderMtime(dir);
  }
  return { removed };
}
