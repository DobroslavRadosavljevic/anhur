import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";

/**
 * Output names written by Anhur: `assetFileName()` in `@anhur/core` gives
 * `<slug>-<16 hex>.<ext>` (slug of `a-z0-9` words joined by `-`).
 */
const HASHED_ASSET_NAME =
  /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{16}(?:\.[a-z0-9]{1,16})?$/;

/**
 * True for a content-hashed asset name (no folders). With `extensions`,
 * the extension must be one of them as well.
 */
export function isHashedAssetName(
  name: string,
  extensions?: readonly string[],
): boolean {
  if (!HASHED_ASSET_NAME.test(name)) return false;
  return extensions === undefined || extensions.includes(path.extname(name));
}

/**
 * Asset hash of a file as `@anhur/core` computes it: 16 hex chars of the
 * SHA-256 of `${version}\0` followed by the bytes (only the bytes without a
 * version). Streams, so files of any size work.
 */
export function hashAssetFile(
  file: string,
  version: string | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    if (version !== undefined) hash.update(`${version}\0`);
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => {
        resolve(hash.digest("hex").slice(0, 16));
      });
  });
}

/** {@link hashAssetFile} for bytes already in memory. */
export function hashAssetBytes(
  bytes: Uint8Array,
  version: string | undefined,
): string {
  const hash = createHash("sha256");
  if (version !== undefined) hash.update(`${version}\0`);
  return hash.update(bytes).digest("hex").slice(0, 16);
}
