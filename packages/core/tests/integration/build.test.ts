import { readdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { build, check, createAnhur, isAnhurBuildError } from "../../src/build";
import { createProject, type TestProject } from "../fixtures/temp-project";

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

async function project(files: { readonly [file: string]: string }) {
  const created = await createProject(files);
  projects.push(created);
  return created;
}

const BLOG_CONFIG = `
import { defineCollection, defineConfig, defineSingleton, defineView, schema as s } from "@anhur/core";

const authors = defineCollection({
  name: "authors",
  directory: "content/authors",
  include: "*.yml",
  localized: false,
  schema: s.object({ name: s.string() }),
  transform: (doc) => ({ ...doc, upper: doc.name.toUpperCase() }),
});

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    date: s.isodate(),
    author: s.reference("authors", { embed: true }),
    toc: s.toc(),
    body: s.raw(),
    draft: s.boolean().optional(),
  }),
  transform: (doc, ctx) => ({ ...doc, authors: ctx.documents("authors").length }),
});

const settings = defineSingleton({
  name: "settings",
  directory: "content/settings",
  schema: s.object({ siteName: s.string(), launched: s.coerce.date() }),
});

const recent = defineView({ name: "recentPosts", from: posts, generate: { listSort: { by: "date", order: "desc" } } });

export default defineConfig({
  localization: { strategy: "folder", locales: ["en", "de"], defaultLocale: "en" },
  content: [authors, posts, settings],
  views: [recent],
});
`;

const BLOG_FILES = {
  "anhur.config.ts": BLOG_CONFIG,
  "content/authors/ada.yml": "name: Ada\n",
  "content/posts/en/hello.md":
    "---\ntitle: Hello\ndate: 2024-01-02\nauthor: ada\n---\n# Intro\n\nBody\n",
  "content/posts/en/guides/Café Intro.md":
    "---\ntitle: Café\ndate: 2024-03-01\nauthor: ada\n---\nText\n",
  "content/posts/de/hallo.md":
    "---\ntitle: Hallo\ndate: 2024-01-03\nauthor: ada\ndraft: true\n---\nEntwurf\n",
  "content/settings/en/index.yml": "siteName: Blog\nlaunched: 2024-05-01\n",
  "content/settings/de/index.yml": "siteName: Blog DE\nlaunched: 2024-05-01\n",
};

type Generated = {
  readonly allPosts: readonly {
    readonly title: string;
    readonly body?: string;
    readonly slug: string;
  }[];
  readonly allRecentPosts: readonly { readonly title: string }[];
  readonly getPost: (query: {
    locale: string;
    id?: string;
    slug?: string;
  }) => Promise<{
    readonly title: string;
    readonly author: { readonly name: string; readonly upper: string };
    readonly authors: number;
  } | null>;
  readonly settings: { readonly siteName: string; readonly launched: Date };
  readonly settingsAll: readonly { readonly siteName: string }[];
  readonly getSettings: (query?: {
    locale?: string;
  }) => Promise<{ readonly siteName: string } | null>;
  readonly locales: readonly string[];
};

async function importGenerated(dir: string): Promise<Generated> {
  // SAFETY: the generated index exports the members listed in Generated (checked by the assertions below).
  return (await import(
    `${pathToFileURL(`${dir}/.anhur/generated/index.js`).href}?t=${Math.random()}`
  )) as Generated;
}

describe("build", () => {
  it("generates importable modules with exact getters, embeds and Date values", async () => {
    const blog = await project(BLOG_FILES);
    const result = await build({ rootDir: blog.dir });
    expect(result.documentCount).toBe(5);
    expect(
      result.sources.find((source) => source.name === "posts")?.documents,
    ).toEqual(["en/guides/Café Intro", "en/hello"]);

    const generated = await importGenerated(blog.dir);
    expect(generated.locales).toEqual(["en", "de"]);
    expect(generated.allPosts.map((post) => post.title).sort()).toEqual([
      "Café",
      "Hello",
    ]);
    expect(generated.allPosts.every((post) => post.body === undefined)).toBe(
      true,
    );
    expect(generated.allRecentPosts.map((post) => post.title)).toEqual([
      "Café",
      "Hello",
    ]);

    const nested = await generated.getPost({
      locale: "en",
      id: "guides/Café Intro",
    });
    expect(nested?.title).toBe("Café");
    expect(nested?.author).toMatchObject({ name: "Ada", upper: "ADA" });
    expect(nested?.authors).toBe(1);
    const bySlug = await generated.getPost({
      locale: "en",
      slug: "guides-cafe-intro",
    });
    expect(bySlug?.title).toBe("Café");
    expect(await generated.getPost({ locale: "de", id: "hallo" })).toBeNull();

    expect(generated.settings.siteName).toBe("Blog");
    expect(generated.settings.launched).toBeInstanceOf(Date);
    expect(generated.settingsAll.map((entry) => entry.siteName)).toEqual([
      "Blog",
      "Blog DE",
    ]);
    expect((await generated.getSettings({ locale: "de" }))?.siteName).toBe(
      "Blog DE",
    );

    const modules = await readdir(
      blog.path(".anhur/generated/documents/posts"),
    );
    expect(modules.every((name) => /^[a-z0-9-]+\.js$/.test(name))).toBe(true);
  });

  it("only rewrites changed files and removes files of deleted documents", async () => {
    const blog = await project(BLOG_FILES);
    const session = createAnhur({ rootDir: blog.dir });
    try {
      const first = await session.build();
      expect(first.written.length).toBeGreaterThan(0);
      const second = await session.build();
      expect(second.written).toEqual([]);
      await blog.write(
        "content/posts/en/hello.md",
        BLOG_FILES["content/posts/en/hello.md"].replace("Body", "Changed"),
      );
      const third = await session.build();
      expect(
        third.written.some((file) => file.includes("documents/posts/en-hello")),
      ).toBe(true);
      expect(third.written.some((file) => file.endsWith("allAuthors.js"))).toBe(
        false,
      );
      await rm(blog.path("content/posts/en/guides/Café Intro.md"));
      const fourth = await session.build();
      expect(
        fourth.removed.some((file) => file.includes("guides-cafe-intro")),
      ).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("check() validates without writing anything", async () => {
    const blog = await project(BLOG_FILES);
    const result = await check({ rootDir: blog.dir });
    expect(result.dryRun).toBe(true);
    await expect(readdir(blog.path(".anhur/generated"))).rejects.toThrow();
  });

  it("runs concurrent builds of one project without corrupting output", async () => {
    const blog = await project(BLOG_FILES);
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map(() => build({ rootDir: blog.dir })),
    );
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const generated = await importGenerated(blog.dir);
    expect(generated.allPosts).toHaveLength(2);
  });

  it("refuses to write into a folder Anhur did not create", async () => {
    const blog = await project({
      ...BLOG_FILES,
      "anhur.config.ts": BLOG_CONFIG.replace(
        "views: [recent],",
        'views: [recent],\n  outputDir: "src",',
      ),
      "src/app.ts": "export const keep = true;\n",
    });
    const error = await build({ rootDir: blog.dir }).catch(
      (cause: unknown) => cause,
    );
    expect(isAnhurBuildError(error) && error.diagnostics[0]?.code).toBe(
      "output-unsafe",
    );
    expect(await blog.read("src/app.ts")).toContain("keep");
  });
});
