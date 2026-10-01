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

async function listFiles(dir: string): Promise<string[] | undefined> {
  try {
    return await readdir(dir);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return undefined;
    throw cause;
  }
}

/**
 * Files Anhur may delete in `dir`: those in its manifest. A folder without
 * a manifest is only adopted when it is empty or every (non-dot) file is a
 * content-hashed name with an allowed extension (folders of older
 * versions). Throws otherwise, so user files are never removed.
 */
async function ownedFiles(
  dir: string,
  extensions: readonly string[] | undefined,
): Promise<ReadonlySet<string>> {
  const manifest = await readAssetsManifest(dir);
  if (manifest) return new Set(manifest);
  const entries = (await listFiles(dir))?.filter(
    (entry) => !entry.startsWith("."),
  );
  if (!entries || entries.length === 0) return new Set();
  if (entries.every((entry) => isHashedAssetName(entry, extensions))) {
    return new Set(entries);
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

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return false;
    throw cause;
  }
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
 */
export async function copyAssets(
  dir: string,
  assets: readonly AssetRef[],
  options: CopyOptions,
): Promise<CopyResult> {
  const previous = await ownedFiles(dir, options.extensions);
  const unique = uniqueByName(assets);
  await mkdir(dir, { recursive: true });
  const present = new Set<string>();
  let copied = 0;
  try {
    await runPool(
      unique,
      checkConcurrency(options.concurrency),
      async (asset) => {
        const target = path.join(dir, asset.fileName);
        if (!(await exists(target))) {
          await copyOne(asset, target, options.svg);
          copied += 1;
        }
        present.add(asset.fileName);
      },
    );
  } catch (cause) {
    // The copy failure is the error to report; the manifest is best effort.
    await writeManifest(dir, [...previous, ...present]).catch(() => undefined);
    throw cause;
  }
  await writeManifest(dir, [...previous, ...present]);
  return { copied };
}

/**
 * Delete files of earlier builds that `assets` no longer uses (only names
 * in the manifest), then make the manifest list exactly `assets`. Run it
 * after the generated modules that point at the new files are published.
 */
export async function pruneAssets(
  dir: string,
  assets: readonly AssetRef[],
  options: { readonly extensions?: readonly string[] } = {},
): Promise<PruneResult> {
  const previous = await ownedFiles(dir, options.extensions);
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
  await writeManifest(dir, kept);
  return { removed };
}
