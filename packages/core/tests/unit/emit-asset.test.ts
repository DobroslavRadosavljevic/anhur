import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBuildContext,
  defineCollection,
  defineConfig,
  defineProcessor,
  schema as s,
} from "../../src/index";

describe("emitAsset", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("records source paths and prefixes src with the host public path", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-emit-"));
    const source = path.join(dir, "cover.png");
    await writeFile(source, "png-bytes");

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
      rootDir: dir,
      configDir: dir,
      publicPathPrefix: "/blog/",
    });

    const emitted = await ctx.emitAsset(source);
    expect(emitted.sourcePath).toBe(path.resolve(source));
    expect(emitted.src).toMatch(/^\/blog\/anhur-assets\/cover-/);
    expect(ctx.assets?.localBase).toBe("/anhur-assets/");
    expect(ctx.assets?.configuredBase).toBe("/anhur-assets/");
    expect(ctx.getEmittedAssetSources()).toEqual([path.resolve(source)]);
  });
});
