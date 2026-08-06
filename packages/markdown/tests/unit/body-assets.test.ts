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
});
