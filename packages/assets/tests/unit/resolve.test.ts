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
import sharp from "sharp";
import {
  assets,
  isPassThroughUrl,
  resolveAndEmit,
  splitAssetUrl,
} from "../../src/index";

describe("asset URL helpers", () => {
  it("treats URL schemes as case-insensitive", () => {
    expect(isPassThroughUrl("HTTPS://cdn.example.com/x.png")).toBe(true);
    expect(isPassThroughUrl("HTTP://cdn.example.com/x.png")).toBe(true);
    expect(isPassThroughUrl("MAILTO:hi@example.com")).toBe(true);
  });

  it("splits query and hash suffixes from relative paths", () => {
    expect(splitAssetUrl("./lake.png?w=800")).toEqual({
      pathname: "./lake.png",
      suffix: "?w=800",
    });
    expect(splitAssetUrl("./lake.png#icon")).toEqual({
      pathname: "./lake.png",
      suffix: "#icon",
    });
  });
});

describe("resolveAndEmit query suffix", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("emits the file path and keeps the query string on the public URL", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-asset-query-"));
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .png()
      .toFile(path.join(dir, "lake.png"));
    const docPath = path.join(dir, "post.md");
    await writeFile(docPath, "---\ntitle: T\n---\n");

    const config = defineConfig({
      processors: [assets({ dir: ".anhur/assets", base: "/anhur-assets/" })],
      content: [
        {
          type: "collection",
          name: "posts",
          typeName: "Posts",
          directory: "content",
          include: "**/*.md",
          schema: s.object({ title: s.string() }),
        },
      ],
    });
    const buildContext = await createBuildContext(config, {
      rootDir: dir,
      configDir: dir,
    });

    const src = await withBuildContext(buildContext, () =>
      withDocumentMeta(
        {
          path: docPath,
          sourceName: "posts",
          config,
        },
        () => resolveAndEmit("./lake.png?w=800", docPath),
      ),
    );

    expect(src).toMatch(/^\/anhur-assets\/lake-[a-f0-9]+\.png\?w=800$/);
  });
});
