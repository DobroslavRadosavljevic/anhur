import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBuildContext,
  defineCollection,
  defineConfig,
  defineProcessor,
  pruneEmittedAssets,
  schema as s,
} from "../../src/index";

const scratchRoot = path.join(import.meta.dirname, "../.temp");
const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("assets prune without wipe-on-start", () => {
  it("keeps pre-existing assets until prune after a successful emit pass", async () => {
    await mkdir(scratchRoot, { recursive: true });
    const root = await mkdtemp(path.join(scratchRoot, "assets-prune-"));
    scratchRoots.push(root);
    const assetsDir = path.join(root, ".anhur/assets");
    await mkdir(assetsDir, { recursive: true });
    const stale = path.join(assetsDir, "stale-oldhash.png");
    await writeFile(stale, "stale");

    const config = defineConfig({
      processors: [
        defineProcessor("assets", {
          dir: ".anhur/assets",
          base: "/anhur-assets/",
        }),
      ],
      content: [
        defineCollection({
          name: "posts",
          directory: "content",
          include: "**/*.md",
          schema: s.object({ title: s.string() }),
        }),
      ],
    });

    const ctx = await createBuildContext(config, {
      rootDir: root,
      configDir: root,
    });

    // Live assets must still be present — createBuildContext must not wipe them.
    expect(await readFile(stale, "utf8")).toBe("stale");

    const source = path.join(root, "fresh.png");
    await writeFile(source, "fresh-bytes");
    const emitted = await ctx.emitAsset(source);
    expect(emitted.src).toMatch(/^\/anhur-assets\/fresh-/);

    await pruneEmittedAssets(ctx);

    const remaining = await readdir(assetsDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatch(/^fresh-/);
  });
});
