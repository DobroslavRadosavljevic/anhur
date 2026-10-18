import { readdir, rm, utimes } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssetRef } from "@anhur/core/plugin";
import {
  ASSETS_MANIFEST,
  copyAssets,
  createAssetsFolderState,
  pruneAssets,
} from "../../src";
import { assetRef } from "../fixtures/asset-ref";
import { createProject, type TestProject } from "../fixtures/temp-project";

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

type Session = {
  readonly target: string;
  readonly a: AssetRef;
  readonly b: AssetRef;
  /** One build of the session: copy before publish, prune after it. */
  readonly build: (
    assets: readonly AssetRef[],
  ) => Promise<{ readonly copied: number; readonly removed: number }>;
  /** Files in the folder, without the manifest. */
  readonly files: () => Promise<string[]>;
};

/** A session with one folder state, as the plugin keeps one. */
async function session(): Promise<Session> {
  const dir = await createProject({ "src/a.png": "A", "src/b.png": "B" });
  projects.push(dir);
  const target = dir.path("out");
  const state = createAssetsFolderState();
  return {
    target,
    a: assetRef(dir.path("src/a.png"), "A"),
    b: assetRef(dir.path("src/b.png"), "B", { stem: "b" }),
    build: async (assets) => {
      const { copied } = await copyAssets(
        target,
        assets,
        { svg: "keep" },
        state,
      );
      const { removed } = await pruneAssets(target, assets, {}, state);
      return { copied, removed };
    },
    files: async () => {
      const entries = await readdir(target);
      return entries.filter((entry) => entry !== ASSETS_MANIFEST).sort();
    },
  };
}

/** Age of a folder mtime that can prove "unchanged" (long ago). */
const OLD_MS = 60_000;
/** Age of a folder mtime that proves nothing (written at this moment). */
const NEW_MS = 0;

/**
 * Build, give the folder an mtime that is `ageMs` old, and build again:
 * the session then knows the folder with exactly the returned mtime.
 */
async function buildAt(
  { build, target }: Session,
  assets: readonly AssetRef[],
  ageMs: number,
): Promise<Date> {
  await build(assets);
  const time = new Date(Date.now() - ageMs);
  await utimes(target, time, time);
  await build(assets);
  return time;
}

/**
 * Put the mtime of the folder back after a change, as when the change is
 * in the same time step of the file system as the last build. Only a
 * build that reads the folder can see such a change.
 */
async function hideChange(target: string, time: Date): Promise<void> {
  await utimes(target, time, time);
}

describe("copyAssets / pruneAssets with a folder state", () => {
  // Catches: a state that never skips, so each build of a dev session
  // reads the folder again. Only a skip gives this result: a copy that
  // reads the folder copies the file that is gone, and a prune that reads
  // the manifest removes the file of the other build.
  it("does not read a folder that is old and has the mtime the last build saw", async () => {
    const dev = await session();
    const { a, b, build, files, target } = dev;
    const old = await buildAt(dev, [a], OLD_MS);

    await rm(path.join(target, a.fileName));
    // A build that does not share this session's state.
    await copyAssets(target, [b], { svg: "keep" });
    await hideChange(target, old);
    expect(await build([a])).toEqual({ copied: 0, removed: 0 });
    expect(await files()).toEqual([b.fileName]);
  });

  // Catches: a state that trusts the mtime of a folder written a moment
  // ago. A change in the same time step keeps that mtime, so the build
  // would miss it (a broken image until the dev server starts again).
  it("reads a folder again when its mtime is new, also when the mtime did not change", async () => {
    const dev = await session();
    const { a, build, files, target } = dev;
    const now = await buildAt(dev, [a], NEW_MS);

    await rm(path.join(target, a.fileName));
    await hideChange(target, now);
    expect(await build([a])).toEqual({ copied: 1, removed: 0 });
    expect(await files()).toEqual([a.fileName]);
  });

  // Catches: a skip that does not look at the folder, so a file that is
  // gone stays gone.
  it("copies a file again when it was deleted from a settled folder", async () => {
    const dev = await session();
    const { a, b, build, files, target } = dev;
    await buildAt(dev, [a, b], OLD_MS);

    await rm(path.join(target, b.fileName));
    expect(await build([a, b])).toEqual({ copied: 1, removed: 0 });
    expect(await files()).toEqual([a.fileName, b.fileName].sort());
  });

  // Catches: a skip that does not look at the folder, so files another
  // process left there (a second build of the same project) stay forever.
  it("prunes what another build added to a settled folder", async () => {
    const dev = await session();
    const { a, b, build, files, target } = dev;
    await buildAt(dev, [a], OLD_MS);

    // A build that does not share this session's state.
    await copyAssets(target, [a, b], { svg: "keep" });
    expect(await build([a])).toEqual({ copied: 0, removed: 1 });
    expect(await files()).toEqual([a.fileName]);
  });

  // Catches: a skip that only looks at the folder and not at the assets of
  // the build, so a new asset is not copied and an unused one is not pruned.
  it("never skips a build with other assets than the last one", async () => {
    const dev = await session();
    const { a, b, build, files } = dev;
    await buildAt(dev, [a], OLD_MS);

    // As many assets as before, but another one (an image was edited).
    expect(await build([b])).toEqual({ copied: 1, removed: 1 });
    expect(await files()).toEqual([b.fileName]);
    await buildAt(dev, [b], OLD_MS);
    // One more asset, after the ones of the last build.
    expect(await build([b, a])).toEqual({ copied: 1, removed: 0 });
    await buildAt(dev, [b, a], OLD_MS);
    // One less asset.
    expect(await build([b])).toEqual({ copied: 0, removed: 1 });
    expect(await files()).toEqual([b.fileName]);
  });
});
