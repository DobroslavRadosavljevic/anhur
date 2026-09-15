import {
  ASSETS_PROCESSOR_ID,
  getBuildContext,
  type BuildContext,
} from "@anhur/core";
import { access } from "node:fs/promises";
import path from "node:path";

/**
 * URLs that must not be copied — already public, remote, or in-page.
 */
export function isPassThroughUrl(value: string): boolean {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  return (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("#") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("data:") ||
    lower.startsWith("tel:")
  );
}

/** Document-relative path that should go through emitAsset. */
export function isRelativeAssetUrl(value: string): boolean {
  if (!value || value.trim() === "") return false;
  return !isPassThroughUrl(value);
}

/** Split `./file.png?w=800#icon` into a filesystem path and the `?`/`#` suffix. */
export function splitAssetUrl(value: string): {
  pathname: string;
  suffix: string;
} {
  const trimmed = value.trim();
  const hashIdx = trimmed.indexOf("#");
  const queryIdx = trimmed.indexOf("?");
  let cut = -1;
  if (queryIdx >= 0 && hashIdx >= 0) cut = Math.min(queryIdx, hashIdx);
  else if (queryIdx >= 0) cut = queryIdx;
  else if (hashIdx >= 0) cut = hashIdx;
  if (cut < 0) return { pathname: trimmed, suffix: "" };
  return { pathname: trimmed.slice(0, cut), suffix: trimmed.slice(cut) };
}

export async function resolveLocalPath(
  value: string,
  documentPath: string,
): Promise<string> {
  const { pathname } = splitAssetUrl(value);
  const absolute = path.resolve(path.dirname(documentPath), pathname);
  try {
    await access(absolute);
  } catch {
    throw new Error(`Asset file not found: ${value} (from ${documentPath})`);
  }
  return absolute;
}

export function requireAssetsProcessor(filePath: string): BuildContext {
  const build = getBuildContext();
  const plugin = build.getProcessor(ASSETS_PROCESSOR_ID);
  if (!plugin) {
    throw new Error(
      `Relative assets require an assets() processor. Add assets() from @anhur/assets to defineConfig({ processors }). (file: ${filePath})`,
    );
  }
  return build;
}

/**
 * Resolve a frontmatter or body URL: pass-through or copy via emitAsset.
 * Returns the public `src` string.
 */
export async function resolveAndEmit(
  value: string,
  documentPath: string,
): Promise<string> {
  if (isPassThroughUrl(value)) return value;
  const build = requireAssetsProcessor(documentPath);
  const { suffix } = splitAssetUrl(value);
  const absolute = await resolveLocalPath(value, documentPath);
  const emitted = await build.emitAsset(absolute);
  return `${emitted.src}${suffix}`;
}
