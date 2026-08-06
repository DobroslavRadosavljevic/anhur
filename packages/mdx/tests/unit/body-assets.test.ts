import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { assets } from "@anhur/assets";
import sharp from "sharp";
import { mdx, schema as m } from "../../src/schema";

async function writePng(filePath: string) {
  await sharp({
    create: {
      width: 16,
      height: 8,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .png()
    .toFile(filePath);
}

describe("schema.mdx body assets", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("rewrites relative images when assets() is registered", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-mdx-assets-"));
    await writePng(path.join(dir, "inline.png"));
    const docPath = path.join(dir, "hello.mdx");

    const zodSchema = s.object({
      title: s.string(),
      body: m.mdx(),
    });
    const config = defineConfig({
      processors: [mdx({ gfm: true }), assets()],
      content: [
        {
          type: "collection",
          name: "posts",
          typeName: "Posts",
          directory: "content",
          include: "**/*.mdx",
          schema: zodSchema,
        },
      ],
    });
    const buildContext = await createBuildContext(config, {
      rootDir: dir,
      configDir: dir,
    });

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta(
        {
          path: docPath,
          content: "See ![inline](./inline.png)",
          sourceName: "posts",
          config,
        },
        () => zodSchema.safeParseAsync({ title: "Hi" }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toMatch(/\/anhur-assets\/inline-[a-f0-9]+\.png/);
    }
  });

  it("rewrites relative SVG images when assets() is registered", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-mdx-svg-"));
    await writeFile(
      path.join(dir, "logo.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="black"/></svg>`,
    );
    const docPath = path.join(dir, "hello.mdx");

    const zodSchema = s.object({
      title: s.string(),
      body: m.mdx(),
    });
    const config = defineConfig({
      processors: [mdx({ gfm: true }), assets()],
      content: [
        {
          type: "collection",
          name: "posts",
          typeName: "Posts",
          directory: "content",
          include: "**/*.mdx",
          schema: zodSchema,
        },
      ],
    });
    const buildContext = await createBuildContext(config, {
      rootDir: dir,
      configDir: dir,
    });

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta(
        {
          path: docPath,
          content: "See ![logo](./logo.svg)",
          sourceName: "posts",
          config,
        },
        () => zodSchema.safeParseAsync({ title: "Hi" }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toMatch(/\/anhur-assets\/logo-[a-f0-9]+\.svg/);
    }
  });

  it("rejects relative body images without assets()", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-mdx-no-assets-"));
    await writePng(path.join(dir, "inline.png"));
    const docPath = path.join(dir, "hello.mdx");

    const zodSchema = s.object({
      title: s.string(),
      body: m.mdx(),
    });
    const config = defineConfig({
      processors: [mdx({ gfm: true })],
      content: [
        {
          type: "collection",
          name: "posts",
          typeName: "Posts",
          directory: "content",
          include: "**/*.mdx",
          schema: zodSchema,
        },
      ],
    });
    const buildContext = await createBuildContext(config, {
      rootDir: dir,
      configDir: dir,
    });

    await expect(
      withBuildContext(buildContext, () =>
        withDocumentMeta(
          {
            path: docPath,
            content: "See ![inline](./inline.png)",
            sourceName: "posts",
            config,
          },
          () => zodSchema.parseAsync({ title: "Hi" }),
        ),
      ),
    ).rejects.toThrow(/require an assets\(\) processor/);
  });

  it("allows remote body images without assets()", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-mdx-remote-"));
    const docPath = path.join(dir, "hello.mdx");

    const zodSchema = s.object({
      title: s.string(),
      body: m.mdx(),
    });
    const config = defineConfig({
      processors: [mdx({ gfm: true })],
      content: [
        {
          type: "collection",
          name: "posts",
          typeName: "Posts",
          directory: "content",
          include: "**/*.mdx",
          schema: zodSchema,
        },
      ],
    });
    const buildContext = await createBuildContext(config, {
      rootDir: dir,
      configDir: dir,
    });

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta(
        {
          path: docPath,
          content: "![r](https://example.com/r.png)",
          sourceName: "posts",
          config,
        },
        () => zodSchema.safeParseAsync({ title: "Hi" }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toContain("https://example.com/r.png");
    }
  });
});
