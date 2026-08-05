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
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("//") ||
    value.startsWith("/") ||
    value.startsWith("#") ||
    value.startsWith("mailto:") ||
    value.startsWith("data:") ||
    value.startsWith("tel:")
  );
}

/** Document-relative path that should go through emitAsset. */
export function isRelativeAssetUrl(value: string): boolean {
  if (!value || value.trim() === "") return false;
  return !isPassThroughUrl(value);
}

export async function resolveLocalPath(
  value: string,
  documentPath: string,
): Promise<string> {
  const absolute = path.resolve(path.dirname(documentPath), value);
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
  const absolute = await resolveLocalPath(value, documentPath);
  const emitted = await build.emitAsset(absolute);
  return emitted.src;
}
