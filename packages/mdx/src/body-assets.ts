import { ASSETS_PROCESSOR_ID, getBuildContext } from "@anhur/core";
import type { PluggableList } from "unified";
import { remarkRejectRelativeLinkedFiles } from "./remark-reject-relative";

/**
 * Prepend body-asset remark plugins:
 * - with `assets()` → copy + rewrite (from @anhur/assets)
 * - without → reject relative URLs
 */
export async function withBodyAssetRemarkPlugins(
  userPlugins: PluggableList = [],
): Promise<PluggableList> {
  const build = getBuildContext();
  const hasAssets = Boolean(build.getProcessor(ASSETS_PROCESSOR_ID));

  if (!hasAssets) {
    return [remarkRejectRelativeLinkedFiles, ...userPlugins];
  }

  try {
    const { remarkCopyLinkedFiles } = await import("@anhur/assets");
    return [remarkCopyLinkedFiles, ...userPlugins];
  } catch (cause) {
    throw new Error(
      'assets() is registered but "@anhur/assets" could not be imported. Install @anhur/assets.',
      { cause },
    );
  }
}
