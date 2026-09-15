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
import { assets } from "@anhur/assets";
import sharp from "sharp";
import { markdown, schema as md } from "../../src/schema";

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

describe("schema.markdown body assets", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("rewrites relative images when assets() is registered", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-md-assets-"));
    await writePng(path.join(dir, "inline.png"));
    const docPath = path.join(dir, "hello.md");

    const zodSchema = s.object({
      title: s.string(),
      body: md.markdown(),
    });
    const config = defineConfig({
      processors: [markdown({ gfm: true }), assets()],
      content: [
        {
          type: "collection",
          name: "pages",
          typeName: "Pages",
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

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta(
        {
          path: docPath,
          content: "See ![inline](./inline.png)",
          sourceName: "pages",
          config,
        },
        () => zodSchema.safeParseAsync({ title: "Hi" }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toMatch(
        /src="\/anhur-assets\/inline-[a-f0-9]+\.png"/,
      );
    }
  });

  it("rewrites relative SVG images when assets() is registered", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-md-svg-"));
    await writeFile(
      path.join(dir, "logo.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="black"/></svg>`,
    );
    const docPath = path.join(dir, "hello.md");

    const zodSchema = s.object({
      title: s.string(),
      body: md.markdown(),
    });
    const config = defineConfig({
      processors: [markdown({ gfm: true }), assets()],
      content: [
        {
          type: "collection",
          name: "pages",
          typeName: "Pages",
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

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta(
        {
          path: docPath,
          content: "See ![logo](./logo.svg)",
          sourceName: "pages",
          config,
        },
        () => zodSchema.safeParseAsync({ title: "Hi" }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toMatch(
        /src="\/anhur-assets\/logo-[a-f0-9]+\.svg"/,
      );
    }
  });

  it("rejects relative body images without assets()", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-md-no-assets-"));
    await writePng(path.join(dir, "inline.png"));
    const docPath = path.join(dir, "hello.md");

    const zodSchema = s.object({
      title: s.string(),
      body: md.markdown(),
    });
    const config = defineConfig({
      processors: [markdown({ gfm: true })],
      content: [
        {
          type: "collection",
          name: "pages",
          typeName: "Pages",
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

    await expect(
      withBuildContext(buildContext, () =>
        withDocumentMeta(
          {
            path: docPath,
            content: "See ![inline](./inline.png)",
            sourceName: "pages",
            config,
          },
          () => zodSchema.parseAsync({ title: "Hi" }),
        ),
      ),
    ).rejects.toThrow(/require an assets\(\) processor/);
  });

  it("rewrites relative file links in HTML output", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-md-file-"));
    await writeFile(path.join(dir, "notes.txt"), "hello");
    const docPath = path.join(dir, "hello.md");

    const zodSchema = s.object({
      title: s.string(),
      body: md.markdown(),
    });
    const config = defineConfig({
      processors: [markdown({ gfm: true }), assets()],
      content: [
        {
          type: "collection",
          name: "pages",
          typeName: "Pages",
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

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta(
        {
          path: docPath,
          content: "[Notes](./notes.txt)",
          sourceName: "pages",
          config,
        },
        () => zodSchema.safeParseAsync({ title: "Hi" }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toMatch(
        /href="\/anhur-assets\/notes-[a-f0-9]+\.txt"/,
      );
    }
  });

  it("rewrites relative images in raw HTML", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-md-html-"));
    await writePng(path.join(dir, "hero.png"));
    const docPath = path.join(dir, "hello.md");

    const zodSchema = s.object({
      title: s.string(),
      body: md.markdown(),
    });
    const config = defineConfig({
      processors: [markdown({ gfm: true }), assets()],
      content: [
        {
          type: "collection",
          name: "pages",
          typeName: "Pages",
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

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta(
        {
          path: docPath,
          content: 'See <img src="./hero.png" alt="hero">',
          sourceName: "pages",
          config,
        },
        () => zodSchema.safeParseAsync({ title: "Hi" }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toMatch(
        /src="\/anhur-assets\/hero-[a-f0-9]+\.png"/,
      );
    }
  });

  it("rejects relative HTML images without assets()", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-md-html-no-assets-"));
    const docPath = path.join(dir, "hello.md");

    const zodSchema = s.object({
      title: s.string(),
      body: md.markdown(),
    });
    const config = defineConfig({
      processors: [markdown({ gfm: true })],
      content: [
        {
          type: "collection",
          name: "pages",
          typeName: "Pages",
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

    await expect(
      withBuildContext(buildContext, () =>
        withDocumentMeta(
          {
            path: docPath,
            content: 'See <img src="./hero.png" alt="hero">',
            sourceName: "pages",
            config,
          },
          () => zodSchema.parseAsync({ title: "Hi" }),
        ),
      ),
    ).rejects.toThrow(/require an assets\(\) processor/);
  });

  it("rewrites relative srcset candidates in raw HTML", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-md-srcset-"));
    await writePng(path.join(dir, "hero.png"));
    await writePng(path.join(dir, "hero2.png"));
    const docPath = path.join(dir, "hello.md");

    const zodSchema = s.object({
      title: s.string(),
      body: md.markdown(),
    });
    const config = defineConfig({
      processors: [markdown({ gfm: true }), assets()],
      content: [
        {
          type: "collection",
          name: "pages",
          typeName: "Pages",
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

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta(
        {
          path: docPath,
          content:
            'See <img src="./hero.png" srcset="./hero.png 1x, ./hero2.png 2x" alt="hero">',
          sourceName: "pages",
          config,
        },
        () => zodSchema.safeParseAsync({ title: "Hi" }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toMatch(
        /src="\/anhur-assets\/hero-[a-f0-9]+\.png"/,
      );
      expect(result.data.body).toMatch(
        /\/anhur-assets\/hero-[a-f0-9]+\.png 1x/,
      );
      expect(result.data.body).toMatch(
        /\/anhur-assets\/hero2-[a-f0-9]+\.png 2x/,
      );
    }
  });

  it("rejects relative srcset URLs without assets()", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-md-srcset-no-assets-"));
    const docPath = path.join(dir, "hello.md");

    const zodSchema = s.object({
      title: s.string(),
      body: md.markdown(),
    });
    const config = defineConfig({
      processors: [markdown({ gfm: true })],
      content: [
        {
          type: "collection",
          name: "pages",
          typeName: "Pages",
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

    await expect(
      withBuildContext(buildContext, () =>
        withDocumentMeta(
          {
            path: docPath,
            content:
              'See <img srcset="./hero.png 1x, ./hero2.png 2x" alt="hero">',
            sourceName: "pages",
            config,
          },
          () => zodSchema.parseAsync({ title: "Hi" }),
        ),
      ),
    ).rejects.toThrow(/require an assets\(\) processor/);
  });
});
