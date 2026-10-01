import { describe, expect, it } from "vitest";
import {
  defineCollection,
  defineSingleton,
  defineView,
  schema as s,
} from "../../src";
import {
  resolveAssetBases,
  joinPublicAssetBase,
} from "../../src/engine/asset-urls";
import { resolveProject } from "../../src/engine/resolve";
import { isRelevantChange } from "../../src/engine/watcher.service";
import { defineField } from "../../src/plugin";

const CONFIG = "/project/anhur.config.ts";

function resolve(input: unknown) {
  return resolveProject(input, {
    configPath: CONFIG,
    mode: "build",
    sourceFingerprint: "x",
  });
}

function messages(input: unknown): string[] {
  return resolve(input).diagnostics.map(
    (diagnostic) => `${diagnostic.code}: ${diagnostic.message}`,
  );
}

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: s.object({ title: s.string(), slug: s.slug() }),
});

describe("resolveProject", () => {
  it("accepts a plain object config (no defineConfig) and validates it the same way", () => {
    const result = resolve({ content: [posts] });
    expect(result.diagnostics).toEqual([]);
    expect(result.project?.sources[0]?.root).toBe("/project/content/posts");
    expect(result.project?.outputDir).toBe("/project/.anhur/generated");
  });

  it("reports every problem at once", () => {
    const list = messages({
      content: [posts, posts, { type: "collection", name: "" }],
      views: [posts],
    });
    expect(
      list.some((line) =>
        line.includes('Two content sources are named "posts"'),
      ),
    ).toBe(true);
    expect(list.some((line) => line.includes("content[2]"))).toBe(true);
    expect(
      list.some(
        (line) =>
          line.includes("views[0]") && line.includes("collections belong in"),
      ),
    ).toBe(true);
  });

  it("rejects names that generate invalid or colliding identifiers", () => {
    const siteSettings = defineSingleton({
      name: "site-settings",
      filePath: "site.yml",
      schema: s.object({ title: s.string() }),
    });
    const numeric = defineCollection({
      name: "2024-posts",
      directory: "a",
      include: "*.md",
      schema: s.object({}),
    });
    const a = defineCollection({
      name: "blog_posts",
      directory: "b",
      include: "*.md",
      schema: s.object({}),
    });
    const b = defineCollection({
      name: "blog-posts",
      directory: "c",
      include: "*.md",
      schema: s.object({}),
    });
    const list = messages({ content: [siteSettings, numeric, a, b] });
    expect(
      list.filter((line) => line.startsWith("naming-invalid")).length,
    ).toBeGreaterThan(0);
    expect(
      list.some(
        (line) =>
          line.startsWith("naming-collision") && line.includes("allBlogPosts"),
      ),
    ).toBe(true);
    expect(
      resolve({ content: [siteSettings] }).project?.sources[0],
    ).toMatchObject({
      names: { exportName: "siteSettings", getterName: "getSiteSettings" },
    });
  });

  it("checks localization", () => {
    const list = messages({
      content: [posts],
      localization: {
        strategy: "folder",
        locales: ["en", "en", "default", "../x"],
        defaultLocale: "de",
      },
    });
    expect(list.some((line) => line.includes("listed twice"))).toBe(true);
    expect(list.some((line) => line.includes('"default" is not allowed'))).toBe(
      true,
    );
    expect(list.some((line) => line.includes('"../x" is not allowed'))).toBe(
      true,
    );
    expect(list.some((line) => line.includes("defaultLocale"))).toBe(true);
  });

  it("refuses output and cache folders that would hit the project or content", () => {
    for (const outputDir of [".", "..", "content"]) {
      expect(
        messages({ content: [posts], outputDir }).some((line) =>
          line.startsWith("path-unsafe"),
        ),
      ).toBe(true);
    }
    expect(
      messages({ content: [posts], cacheDir: ".anhur/generated" }).some(
        (line) => line.includes("separate folders"),
      ),
    ).toBe(true);
  });

  it("checks references, embed cycles and required plugins", () => {
    const a = defineCollection({
      name: "a",
      directory: "a",
      include: "*.md",
      schema: s.object({
        b: s.reference("b", { embed: true }),
        missing: s.reference("nope"),
      }),
    });
    const b = defineCollection({
      name: "b",
      directory: "b",
      include: "*.md",
      schema: s.object({
        a: s.reference("a", { embed: true }),
        x: defineField(s.string(), {
          kind: "md",
          requires: "markdown",
          whenAbsent: "skip",
          compile: () => "",
        }),
      }),
    });
    const list = messages({ content: [a, b] });
    expect(list.some((line) => line.includes("form a cycle"))).toBe(true);
    expect(list.some((line) => line.includes('references "nope"'))).toBe(true);
    expect(
      list.some((line) => line.includes('needs the "markdown" plugin')),
    ).toBe(true);
  });

  it("validates views", () => {
    const pages = defineCollection({
      name: "pages",
      directory: "p",
      include: "*.md",
      schema: s.object({ title: s.string() }),
    });
    const merged = defineView({
      name: "merged",
      from: [posts, pages] as const,
      select: (doc) => ({ title: doc.title }),
    });
    const outside = defineView({ name: "outside", from: pages });
    const badLimit = defineView({
      name: "badLimit",
      from: posts,
      generate: { limit: 1.5 },
    });
    const list = messages({
      content: [posts],
      views: [merged, outside, badLimit],
    });
    expect(
      list.some((line) => line.includes("not in defineConfig({ content })")),
    ).toBe(true);
    expect(
      list.some((line) => line.includes("limit must be a whole number")),
    ).toBe(true);
  });
});

describe("asset URLs", () => {
  it("joins the app base and keeps CDN bases", () => {
    expect(joinPublicAssetBase("/app/", "/anhur-assets/")).toBe(
      "/app/anhur-assets/",
    );
    expect(joinPublicAssetBase("/app/", "/app/anhur-assets/")).toBe(
      "/app/anhur-assets/",
    );
    expect(resolveAssetBases("https://cdn.example.com/x", "/app/")).toEqual({
      publicBase: "https://cdn.example.com/x/",
      localBase: undefined,
    });
    expect(resolveAssetBases("/app/anhur-assets/", "/app/")).toEqual({
      publicBase: "/app/anhur-assets/",
      localBase: "/anhur-assets/",
    });
  });
});

describe("watch relevance", () => {
  const targets = {
    directories: ["/p/content"],
    files: ["/p/anhur.config.ts", "/p/img/a.png"],
    ignore: ["/p/.anhur/generated", "/p/content/.anhur"],
  };
  it("rebuilds for content and dependencies, never for own output or temp files", () => {
    expect(isRelevantChange("/p/content/posts/2024/a.md", targets)).toBe(true);
    expect(isRelevantChange("/p/anhur.config.ts", targets)).toBe(true);
    expect(isRelevantChange("/p/img/a.png", targets)).toBe(true);
    expect(isRelevantChange("/p/.anhur/generated/index.js", targets)).toBe(
      false,
    );
    expect(isRelevantChange("/p/content/posts/.a.md.swp", targets)).toBe(false);
    expect(isRelevantChange("/p/content/posts/a.md~", targets)).toBe(false);
    expect(isRelevantChange("/p/README.md", targets)).toBe(false);
  });
});
