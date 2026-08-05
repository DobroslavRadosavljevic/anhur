import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBuildContext,
  defineConfig,
  schema as s,
  withBuildContext,
  withDocumentMeta,
} from "@anhur/core";
import { assets, schema as a } from "../../src/schema";
import sharp from "sharp";

describe("schema.image / schema.file", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup(withAssets: boolean) {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-assets-"));
    const png = path.join(dir, "cover.png");
    await sharp({
      create: {
        width: 32,
        height: 16,
        channels: 3,
        background: { r: 20, g: 40, b: 80 },
      },
    })
      .png()
      .toFile(png);

    const docPath = path.join(dir, "post.md");
    await writeFile(docPath, "---\ntitle: T\n---\n");

    const zodSchema = s.object({
      title: s.string(),
      cover: a.image(),
      pdf: a.file().optional(),
    });

    const config = defineConfig({
      processors: withAssets
        ? [assets({ dir: ".anhur/assets", base: "/anhur-assets/" })]
        : [],
      content: [
        {
          type: "collection",
          name: "posts",
          typeName: "Posts",
          directory: "content",
          include: "**/*.md",
          schema: zodSchema,
        },
      ],
    });

    const buildContext = await createBuildContext(config, {
      rootDir: dir,
      configDir: dir,
    });

    return { zodSchema, config, buildContext, docPath, png };
  }

  it("copies image and returns metadata when assets processor is registered", async () => {
    const { zodSchema, config, buildContext, docPath } = await setup(true);

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta(
        {
          path: docPath,
          sourceName: "posts",
          config,
        },
        () =>
          zodSchema.safeParseAsync({
            title: "Hi",
            cover: "./cover.png",
          }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cover.src).toMatch(/^\/anhur-assets\/cover-/);
      expect(result.data.cover.width).toBe(32);
      expect(result.data.cover.height).toBe(16);
      expect(result.data.cover.blurDataURL).toMatch(
        /^data:image\/webp;base64,/,
      );
    }
  });

  it("fails when assets processor is missing", async () => {
    const { zodSchema, config, buildContext, docPath } = await setup(false);

    await expect(
      withBuildContext(buildContext, () =>
        withDocumentMeta(
          {
            path: docPath,
            sourceName: "posts",
            config,
          },
          () => zodSchema.parseAsync({ title: "Hi", cover: "./cover.png" }),
        ),
      ),
    ).rejects.toThrow(/require an assets/);
  });

  it("fails when relative file is missing", async () => {
    const { zodSchema, config, buildContext, docPath } = await setup(true);

    await expect(
      withBuildContext(buildContext, () =>
        withDocumentMeta(
          {
            path: docPath,
            sourceName: "posts",
            config,
          },
          () => zodSchema.parseAsync({ title: "Hi", cover: "./nope.png" }),
        ),
      ),
    ).rejects.toThrow(/Asset file not found/);
  });
});
