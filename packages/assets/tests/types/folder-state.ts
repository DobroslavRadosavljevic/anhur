/**
 * Type tests (checked by `tsc -p tsconfig.tests.json`, never run): the
 * folder state is opaque. Its fields are not part of the public API, so
 * they can change without a break for callers.
 */
import {
  copyAssets,
  createAssetsFolderState,
  pruneAssets,
  type AssetsFolderState,
  type CopyResult,
  type PruneResult,
} from "../../src";

const state = createAssetsFolderState();

/** A state is only made by `createAssetsFolderState()` and given back. */
export function build(): Promise<[CopyResult, PruneResult]> {
  return Promise.all([
    copyAssets("out", [], { svg: "keep" }, state),
    pruneAssets("out", [], {}, state),
  ]);
}

// @ts-expect-error a state has no fields to read
export const folderMtime: unknown = state.mtimeMs;
// @ts-expect-error a state cannot be made by hand
export const empty: AssetsFolderState = {};
export const record: AssetsFolderState = {
  // @ts-expect-error the fields a state once had are not its type
  assets: undefined,
  mtimeMs: undefined,
  readAt: 0,
};
