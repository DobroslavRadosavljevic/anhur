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
import { compile, type CompileOptions } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";
import sharp from "sharp";
import {
  assets,
  remarkCopyLinkedFiles,
  remarkRejectRelativeLinkedFiles,
  schema as a,
} from "../../src/index";

async function writePng(filePath: string, color = { r: 20, g: 40, b: 80 }) {
  await sharp({
    create: {
      width: 24,
      height: 12,
      channels: 3,
      background: color,
    },
  })
    .png()
    .toFile(filePath);
}

describe("remarkCopyLinkedFiles", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup() {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-body-assets-"));
    const png = path.join(dir, "lake.png");
    const pdf = path.join(dir, "guide.pdf");
    const svg = path.join(dir, "logo.svg");
    await writePng(png);
    await writeFile(pdf, "%PDF-1.4 fake");
    await writeFile(
      svg,
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="green"/></svg>`,
    );
    const docPath = path.join(dir, "post.mdx");
    await writeFile(docPath, "---\ntitle: T\n---\n");

    const config = defineConfig({
      processors: [assets({ dir: ".anhur/assets", base: "/anhur-assets/" })],
      content: [
        {
          type: "collection",
          name: "posts",
          typeName: "Posts",
          directory: "content",
          include: "**/*.mdx",
          schema: s.object({ title: s.string() }),
        },
      ],
    });
    const buildContext = await createBuildContext(config, {
      rootDir: dir,
      configDir: dir,
    });
    return { docPath, config, buildContext, png, pdf, svg };
  }

  async function compileWithCopy(source: string, docPath: string) {
    const file = await compile(
      { value: source, path: docPath },
      {
        outputFormat: "function-body",
        remarkPlugins: [
          remarkGfm,
          remarkCopyLinkedFiles,
        ] as CompileOptions["remarkPlugins"],
      },
    );
    return String(file);
  }

  it("rewrites relative markdown images", async () => {
    const { docPath, config, buildContext } = await setup();

    const code = await withBuildContext(buildContext, () =>
      withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
        compileWithCopy("![Lake](./lake.png)", docPath),
      ),
    );

    expect(code).toMatch(/\/anhur-assets\/lake-[a-f0-9]+\.png/);
    expect(code).not.toContain("./lake.png");
  });

  it("rewrites relative markdown file links", async () => {
    const { docPath, config, buildContext } = await setup();

    const code = await withBuildContext(buildContext, () =>
      withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
        compileWithCopy("[Guide](./guide.pdf)", docPath),
      ),
    );

    expect(code).toMatch(/\/anhur-assets\/guide-[a-f0-9]+\.pdf/);
  });

  it("rewrites relative SVG markdown images", async () => {
    const { docPath, config, buildContext } = await setup();

    const code = await withBuildContext(buildContext, () =>
      withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
        compileWithCopy("![Logo](./logo.svg)", docPath),
      ),
    );

    expect(code).toMatch(/\/anhur-assets\/logo-[a-f0-9]+\.svg/);
    expect(code).not.toContain("./logo.svg");
  });

  it("rewrites relative SVG file links", async () => {
    const { docPath, config, buildContext } = await setup();

    const code = await withBuildContext(buildContext, () =>
      withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
        compileWithCopy("[Logo](./logo.svg)", docPath),
      ),
    );

    expect(code).toMatch(/\/anhur-assets\/logo-[a-f0-9]+\.svg/);
  });

  it("rewrites MDX JSX string src for SVG", async () => {
    const { docPath, config, buildContext } = await setup();

    const code = await withBuildContext(buildContext, () =>
      withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
        compileWithCopy('<img src="./logo.svg" alt="Logo" />', docPath),
      ),
    );

    expect(code).toMatch(/\/anhur-assets\/logo-[a-f0-9]+\.svg/);
  });

  it("rewrites MDX JSX string src attributes", async () => {
    const { docPath, config, buildContext } = await setup();

    const code = await withBuildContext(buildContext, () =>
      withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
        compileWithCopy('<img src="./lake.png" alt="Lake" />', docPath),
      ),
    );

    expect(code).toMatch(/\/anhur-assets\/lake-[a-f0-9]+\.png/);
  });

  it("leaves remote and absolute URLs unchanged", async () => {
    const { docPath, config, buildContext } = await setup();

    const code = await withBuildContext(buildContext, () =>
      withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
        compileWithCopy(
          "![a](https://example.com/a.png) ![b](/public/b.png) ![c](//cdn.example/c.png)",
          docPath,
        ),
      ),
    );

    expect(code).toContain("https://example.com/a.png");
    expect(code).toContain("/public/b.png");
    expect(code).toContain("//cdn.example/c.png");
  });

  it("leaves mailto, hash, and data URLs unchanged", async () => {
    const { docPath, config, buildContext } = await setup();

    const code = await withBuildContext(buildContext, () =>
      withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
        compileWithCopy(
          "[mail](mailto:a@b.c) [top](#section) ![d](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)",
          docPath,
        ),
      ),
    );

    expect(code).toContain("mailto:a@b.c");
    expect(code).toContain("#section");
    expect(code).toContain("data:image/gif;base64,");
  });

  it("dedupes the same relative file referenced twice", async () => {
    const { docPath, config, buildContext } = await setup();

    const code = await withBuildContext(buildContext, () =>
      withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
        compileWithCopy("![one](./lake.png)\n\n![two](./lake.png)", docPath),
      ),
    );

    const matches = code.match(/\/anhur-assets\/lake-[a-f0-9]+\.png/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(new Set(matches).size).toBe(1);
  });

  it("fails when the relative file is missing", async () => {
    const { docPath, config, buildContext } = await setup();

    await expect(
      withBuildContext(buildContext, () =>
        withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
          compileWithCopy("![missing](./nope.png)", docPath),
        ),
      ),
    ).rejects.toThrow(/Asset file not found/);
  });

  it("fails without assets processor", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-body-no-assets-"));
    const docPath = path.join(dir, "post.mdx");
    await writeFile(docPath, "x");
    await writePng(path.join(dir, "lake.png"));

    const config = defineConfig({
      processors: [],
      content: [
        {
          type: "collection",
          name: "posts",
          typeName: "Posts",
          directory: "content",
          include: "**/*.mdx",
          schema: s.object({ title: s.string() }),
        },
      ],
    });
    const buildContext = await createBuildContext(config, {
      rootDir: dir,
      configDir: dir,
    });

    await expect(
      withBuildContext(buildContext, () =>
        withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
          compileWithCopy("![Lake](./lake.png)", docPath),
        ),
      ),
    ).rejects.toThrow(/require an assets/);
  });

  it("works with reference-style image definitions", async () => {
    const { docPath, config, buildContext } = await setup();

    const code = await withBuildContext(buildContext, () =>
      withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
        compileWithCopy("![Lake][lake]\n\n[lake]: ./lake.png", docPath),
      ),
    );

    expect(code).toMatch(/\/anhur-assets\/lake-[a-f0-9]+\.png/);
  });
});

describe("remarkRejectRelativeLinkedFiles", () => {
  it("throws listing relative urls", async () => {
    await expect(
      compile(
        { value: "![x](./x.png)", path: "/tmp/a.mdx" },
        {
          outputFormat: "function-body",
          remarkPlugins: [
            remarkRejectRelativeLinkedFiles,
          ] as CompileOptions["remarkPlugins"],
        },
      ),
    ).rejects.toThrow(/Found: \.\/x\.png/);
  });

  it("allows pass-through urls", async () => {
    const file = await compile(
      { value: "![x](https://example.com/x.png)", path: "/tmp/a.mdx" },
      {
        outputFormat: "function-body",
        remarkPlugins: [
          remarkRejectRelativeLinkedFiles,
        ] as CompileOptions["remarkPlugins"],
      },
    );
    expect(String(file)).toContain("https://example.com/x.png");
  });
});

describe("schema.image still works alongside body rewrite", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("emits frontmatter image and shares hash with body", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-shared-emit-"));
    await writePng(path.join(dir, "cover.png"));
    const docPath = path.join(dir, "post.md");
    await writeFile(docPath, "---\ntitle: T\n---\n");

    const zodSchema = s.object({
      title: s.string(),
      cover: a.image(),
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

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta({ path: docPath, sourceName: "posts", config }, () =>
        zodSchema.safeParseAsync({
          title: "Hi",
          cover: "./cover.png",
        }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cover.src).toMatch(/^\/anhur-assets\/cover-/);
      expect(result.data.cover.width).toBe(24);
    }
  });
});
