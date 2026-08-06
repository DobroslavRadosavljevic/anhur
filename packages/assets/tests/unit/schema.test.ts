import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
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

const SIZED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="red"/></svg>`;
const EMPTY_SVG = `<svg xmlns="http://www.w3.org/2000/svg"></svg>`;
const VIEWBOX_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="blue"/></svg>`;

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

describe("schema.image / schema.file with SVG", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setupSvg() {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-svg-assets-"));
    await writeFile(path.join(dir, "logo.svg"), SIZED_SVG);
    await writeFile(path.join(dir, "empty.svg"), EMPTY_SVG);
    await writeFile(path.join(dir, "mark.svg"), VIEWBOX_SVG);
    const docPath = path.join(dir, "post.md");
    await writeFile(docPath, "---\ntitle: T\n---\n");

    const zodSchema = s.object({
      title: s.string(),
      cover: a.image().optional(),
      icon: a.file().optional(),
    });

    const config = defineConfig({
      processors: [assets({ dir: ".anhur/assets", base: "/anhur-assets/" })],
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

    return { zodSchema, config, buildContext, docPath };
  }

  it("copies SVG via a.image with size and blur when sharp can rasterize", async () => {
    const { zodSchema, config, buildContext, docPath } = await setupSvg();

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
        zodSchema.safeParseAsync({
          title: "Hi",
          cover: "./logo.svg",
        }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cover?.src).toMatch(
        /^\/anhur-assets\/logo-[a-f0-9]+\.svg$/,
      );
      expect(result.data.cover?.width).toBe(100);
      expect(result.data.cover?.height).toBe(50);
      expect(result.data.cover?.blurDataURL).toMatch(
        /^data:image\/webp;base64,/,
      );

      const emittedName = result.data.cover!.src.replace("/anhur-assets/", "");
      const emitted = await readFile(
        path.join(dir, ".anhur/assets", emittedName),
        "utf8",
      );
      expect(emitted).toBe(SIZED_SVG);
    }
  });

  it("copies SVG via a.image when sharp cannot rasterize", async () => {
    const { zodSchema, config, buildContext, docPath } = await setupSvg();

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
        zodSchema.safeParseAsync({
          title: "Hi",
          cover: "./empty.svg",
        }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cover?.src).toMatch(
        /^\/anhur-assets\/empty-[a-f0-9]+\.svg$/,
      );
      expect(result.data.cover?.width).toBe(0);
      expect(result.data.cover?.height).toBe(0);
      expect(result.data.cover?.blurDataURL).toBe("");
    }
  });

  it("reads viewBox size for SVG when width/height attrs are missing", async () => {
    const { zodSchema, config, buildContext, docPath } = await setupSvg();

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
        zodSchema.safeParseAsync({
          title: "Hi",
          cover: "./mark.svg",
        }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cover?.width).toBe(200);
      expect(result.data.cover?.height).toBe(100);
      expect(result.data.cover?.src).toMatch(/\.svg$/);
    }
  });

  it("copies SVG via a.file without image metadata", async () => {
    const { zodSchema, config, buildContext, docPath } = await setupSvg();

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
        zodSchema.safeParseAsync({
          title: "Hi",
          icon: "./logo.svg",
        }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.icon?.src).toMatch(
        /^\/anhur-assets\/logo-[a-f0-9]+\.svg$/,
      );
      expect(result.data.icon).toEqual({
        src: result.data.icon!.src,
      });
    }
  });
});
