import { createHash } from "node:crypto";
import type { AssetRef } from "@anhur/core/plugin";
import { SVG_SANITIZER_VERSION } from "../../src";

/** Asset hash as core computes it (see `AssetHost.transformVersion`). */
function hashOf(contents: string | Uint8Array, version?: string): string {
  const hash = createHash("sha256");
  if (version !== undefined) hash.update(`${version}\0`);
  return hash.update(contents).digest("hex").slice(0, 16);
}

/** The asset core reports for a source file with these contents. */
export function assetRef(
  sourcePath: string,
  contents: string | Uint8Array,
  options: { readonly stem?: string; readonly svg?: boolean } = {},
): AssetRef {
  const extension = options.svg ? ".svg" : ".png";
  const hash = hashOf(
    contents,
    options.svg ? SVG_SANITIZER_VERSION : undefined,
  );
  const fileName = `${options.stem ?? "a"}-${hash}${extension}`;
  return {
    src: `/a/${fileName}`,
    sourcePath,
    fileName,
    hash,
    size: Buffer.byteLength(contents),
    contentType: options.svg ? "image/svg+xml" : "image/png",
  };
}
