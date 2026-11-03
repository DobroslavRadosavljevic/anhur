/**
 * Scopes in the setups real projects use.
 *
 * Ways it can fail, each checked below:
 * - folder i18n: a scope keeps the wrong locale, or getters still find dropped ones;
 * - a scope drops the document a singleton's export always has (it would
 *   be `undefined` while typed as present), or refuses other locales;
 * - `embed: true` references embed a document the scope dropped;
 * - a multi-collection view still lists dropped documents;
 * - worker threads (many documents) lose the scope filter;
 * - a new process with warm caches rewrites or loses scope files;
 * - two scopes mix their documents;
 * - the CLI `--json` report has no scopes.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { build, createAnhur, isAnhurBuildError } from "../../src/build";
import {
  createProject,
  PACKAGE_DIR,
  type TestProject,
} from "../fixtures/temp-project";

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

async function project(files: { readonly [file: string]: string }) {
  const created = await createProject(files);
  projects.push(created);
  return created;
}

async function failure(run: Promise<unknown>) {
  const error = await run.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!isAnhurBuildError(error)) {
    throw new Error(`expected an AnhurBuildError, got ${String(error)}`);
  }
  return error;
}

const BLOG = `
import { defineCollection, defineConfig, defineSingleton, defineView, schema as s } from "@anhur/core";

const authors = defineCollection({
  name: "authors",
  directory: "content/authors",
  include: "*.yml",
  localized: false,
  schema: s.object({ name: s.string(), hidden: s.boolean().default(false) }),
});

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "*.md",
  schema: s.object({
    title: s.string(),
    author: s.reference("authors", { embed: true }),
    body: s.raw(),
  }),
});

const pages = defineCollection({
  name: "pages",
  directory: "content/pages",
  include: "*.md",
  localized: false,
  schema: s.object({ title: s.string() }),
});

const settings = defineSingleton({
  name: "settings",
  directory: "content/settings",
  schema: s.object({ siteName: s.string() }),
});

const everything = defineView({
  name: "everything",
  from: [posts, pages],
  select: (doc) => ({ title: doc.title }),
});

export default defineConfig({
  localization: { strategy: "folder", locales: ["en", "de"], defaultLocale: "en" },
  content: [authors, posts, pages, settings],
  views: [everything],
  scopes: __SCOPES__,
});
`;

const BLOG_FILES = {
  "content/authors/ada.yml": "name: Ada\n",
  "content/authors/bob.yml": "name: Bob\nhidden: true\n",
  "content/posts/en/hello.md": "---\ntitle: Hello\nauthor: ada\n---\nHi\n",
  "content/posts/de/hallo.md": "---\ntitle: Hallo\nauthor: ada\n---\nHallo\n",
  "content/posts/en/secret.md": "---\ntitle: Secret\nauthor: bob\n---\nShh\n",
  "content/pages/about.md": "---\ntitle: About\n---\n",
  "content/settings/en/index.yml": "siteName: Blog\n",
  "content/settings/de/index.yml": "siteName: Blog DE\n",
};

function blog(scopes: string) {
  return {
    "anhur.config.ts": BLOG.replace("__SCOPES__", scopes),
    ...BLOG_FILES,
  };
}

describe("scopes in real setups", () => {
  it("keeps locales, embeds and multi-collection views consistent per scope", async () => {
    const site = await project(
      blog(`[
        { name: "en", outputDir: ".anhur/en", where: {
          posts: (doc) => doc._meta.locale === "en" && doc.author !== "bob",
          authors: (doc) => !doc.hidden,
        } },
      ]`),
    );
    const result = await build({ rootDir: site.dir });
    const scope = result.scopes[0]!;
    const posts = scope.sources.find((source) => source.name === "posts");
    expect(posts?.documents).toEqual(["en/hello"]);

    const list = await site.read(".anhur/en/allPosts.js");
    expect(list).toContain('"Hello"');
    expect(list).not.toContain("Hallo");
    expect(list).not.toContain("Secret");
    // The embedded author is the kept one.
    expect(list).toContain('"Ada"');
    expect(list).not.toContain('"Bob"');

    const view = await site.read(".anhur/en/allEverythings.js");
    expect(view).toContain('"Hello"');
    expect(view).toContain('"About"');
    expect(view).not.toContain("Secret");

    // The main output still has every document.
    const main = await site.read(".anhur/generated/allPosts.js");
    expect(main).toContain("Secret");
    expect(main).toContain("Hallo");
  });

  it("fails when a kept post embeds an author the scope dropped", async () => {
    const site = await project(
      blog(
        `[{ name: "visible", outputDir: ".anhur/visible", where: { authors: (doc) => !doc.hidden } }]`,
      ),
    );
    const error = await failure(build({ rootDir: site.dir }));
    expect(error.diagnostics).toEqual([
      expect.objectContaining({
        code: "reference-failed",
        file: site.path("content/posts/en/secret.md"),
        message: expect.stringMatching(/^Scope "visible": .*"bob"/),
      }),
    ]);
  });

  it("drops a singleton from a scope without breaking its exports", async () => {
    const site = await project(
      blog(
        `[{ name: "bare", outputDir: ".anhur/bare", where: { settings: (doc) => doc._meta.locale === "en" } }]`,
      ),
    );
    await build({ rootDir: site.dir });
    const index = await site.read(".anhur/bare/settings.js");
    expect(index).toContain('"Blog"');
    expect(index).not.toContain("Blog DE");
  });

  it("refuses a scope that drops the default-locale document of a required singleton", async () => {
    const site = await project(
      blog(
        `[{ name: "bare", outputDir: ".anhur/bare", where: { settings: (doc) => doc._meta.locale === "de" } }]`,
      ),
    );
    const error = await failure(build({ rootDir: site.dir }));
    expect(error.diagnostics).toEqual([
      expect.objectContaining({
        code: "scope-failed",
        source: "settings",
        file: site.path("content/settings/en/index.yml"),
        message:
          'Scope "bare" leaves out the en document of singleton "settings", which its output always has.',
      }),
    ]);
  });

  it("lets a scope drop an optional singleton", async () => {
    const site = await project({
      ...blog(
        `[{ name: "bare", outputDir: ".anhur/bare", where: { settings: () => false } }]`,
      ),
      "anhur.config.ts": BLOG.replace(
        "__SCOPES__",
        `[{ name: "bare", outputDir: ".anhur/bare", where: { settings: () => false } }]`,
      ).replace('name: "settings",', 'name: "settings",\n  optional: true,'),
    });
    const result = await build({ rootDir: site.dir });
    expect(
      result.scopes[0]?.sources.find((source) => source.name === "settings")
        ?.documents,
    ).toEqual([]);
  });

  it("builds two scopes from one build without mixing them", async () => {
    const site = await project(
      blog(`[
        { name: "en", outputDir: ".anhur/en", where: { posts: (doc) => doc._meta.locale === "en" } },
        { name: "de", outputDir: ".anhur/de", where: { posts: (doc) => doc._meta.locale === "de" } },
      ]`),
    );
    const result = await build({ rootDir: site.dir });
    expect(result.scopes.map((scope) => scope.name)).toEqual(["en", "de"]);
    expect(await site.read(".anhur/en/allPosts.js")).not.toContain("Hallo");
    expect(await site.read(".anhur/de/allPosts.js")).toContain("Hallo");
    expect(await site.read(".anhur/de/allPosts.js")).not.toContain('"Hello"');
  });

  it("keeps the filter with worker threads and many documents", async () => {
    const files: Record<string, string> = {
      "anhur.config.ts": `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";

const notes = defineCollection({
  name: "notes",
  directory: "notes",
  include: "*.md",
  localized: false,
  schema: s.object({ title: s.string(), n: s.number(), toc: s.toc(), body: s.raw() }),
});

export default defineConfig({
  content: [notes],
  workers: 2,
  scopes: [{ name: "even", outputDir: ".anhur/even", where: { notes: (doc) => doc.n % 2 === 0 } }],
});
`,
    };
    for (let index = 0; index < 300; index += 1) {
      files[`notes/note-${index}.md`] =
        `---\ntitle: Note ${index}\nn: ${index}\n---\n# Heading ${index}\n\nText.\n`;
    }
    const site = await project(files);
    const result = await build({ rootDir: site.dir });
    expect(result.documentCount).toBe(300);
    expect(result.scopes[0]?.documentCount).toBe(150);
  });

  it("restores scope output from warm caches in a new session without rewriting it", async () => {
    const site = await project(
      blog(
        `[{ name: "en", outputDir: ".anhur/en", where: { posts: (doc) => doc._meta.locale === "en" } }]`,
      ),
    );
    const first = createAnhur({ rootDir: site.dir });
    try {
      expect((await first.build()).scopes[0]?.written.length).toBeGreaterThan(
        0,
      );
    } finally {
      await first.close();
    }
    const second = createAnhur({ rootDir: site.dir });
    try {
      const again = await second.build();
      expect(again.written).toEqual([]);
      expect(again.scopes[0]?.written).toEqual([]);
      expect(again.scopes[0]?.documentCount).toBe(7);
    } finally {
      await second.close();
    }
  });

  it("reports scopes in the CLI JSON report", async () => {
    const site = await project(
      blog(
        `[{ name: "en", outputDir: ".anhur/en", where: { posts: (doc) => doc._meta.locale === "en" } }]`,
      ),
    );
    const cli = path.join(PACKAGE_DIR, "src/cli/main.ts");
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("bun", [cli, "build", "--root", site.dir, "--json"], {
        cwd: site.dir,
      });
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(text) : reject(new Error(`exit ${code}: ${text}`)),
      );
    });
    const report = z
      .object({
        scopes: z.array(
          z.object({ name: z.string(), documentCount: z.number() }),
        ),
      })
      .parse(JSON.parse(output));
    expect(report.scopes).toEqual([
      expect.objectContaining({ name: "en", documentCount: 7 }),
    ]);
  });
});
