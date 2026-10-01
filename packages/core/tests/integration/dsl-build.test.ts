import { pathToFileURL } from "node:url";
import { Predicate } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { build, isAnhurBuildError, type Diagnostic } from "../../src/build";
import {
  isPlainObject,
  type DocumentFields,
  type DocumentValue,
} from "../../src/document";
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

async function diagnosticsOf(files: {
  readonly [file: string]: string;
}): Promise<readonly Diagnostic[]> {
  const created = await project(files);
  const error = await build({ rootDir: created.dir }).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!isAnhurBuildError(error))
    throw new Error(`expected a build error, got ${String(error)}`);
  return error.diagnostics;
}

type Getter = (query: DocumentFields) => Promise<DocumentFields | null>;

type Generated = {
  readonly [name: string]: DocumentValue | Getter;
};

async function importGenerated(dir: string): Promise<Generated> {
  // SAFETY: the generated index exports document data and getter functions; members are checked before use below.
  return (await import(
    `${pathToFileURL(`${dir}/.anhur/generated/index.js`).href}?t=${Math.random()}`
  )) as Generated;
}

function rows(generated: Generated, name: string): DocumentFields[] {
  const value = generated[name];
  if (!Array.isArray(value)) throw new Error(`${name} is not a list`);
  const items: readonly DocumentValue[] = value;
  return items.filter((item) => isPlainObject(item));
}

async function getter(
  generated: Generated,
  name: string,
  query: DocumentFields,
): Promise<DocumentFields | null> {
  const fn = generated[name];
  if (!Predicate.isFunction(fn)) throw new Error(`${name} is not a function`);
  return fn(query);
}

const header = `import { defineCollection, defineConfig, schema as s } from "@anhur/core";
const authors = defineCollection({ name: "authors", directory: "authors", include: "*.yml", schema: s.object({ name: s.string() }) });
`;

describe("schema DSL in a build", () => {
  it("handles discriminated unions: one slug per document, references per variant", async () => {
    const blog = await project({
      "anhur.config.ts": `${header}
const posts = defineCollection({
  name: "posts", directory: "posts", include: "*.md",
  schema: s.discriminatedUnion("kind", [
    s.object({ kind: s.literal("post"), slug: s.slug(), author: s.reference("authors", { embed: true }) }),
    s.object({ kind: s.literal("guest"), slug: s.slug(), author: s.string() }),
  ]),
});
export default defineConfig({ content: [authors, posts] });`,
      "authors/ada.yml": "name: Ada\n",
      "posts/a.md": "---\nkind: post\nauthor: ada\n---\n",
      "posts/b.md": "---\nkind: guest\nauthor: A visiting writer\n---\n",
      "posts/c.md": "---\nkind: guest\nauthor: ada\n---\n",
    });
    await build({ rootDir: blog.dir });
    const generated = await importGenerated(blog.dir);
    const all = rows(generated, "allPosts");
    expect(all.map((row) => row.slug)).toEqual(["a", "b", "c"]);
    const a = await getter(generated, "getPost", { slug: "a" });
    expect(a?.author).toMatchObject({ name: "Ada" });
    const c = await getter(generated, "getPost", { slug: "c" });
    expect(c?.author).toBe("ada");
  });

  it("checks references the transform renamed", async () => {
    const diagnostics = await diagnosticsOf({
      "anhur.config.ts": `${header}
const posts = defineCollection({
  name: "posts", directory: "posts", include: "*.md",
  schema: s.object({ author: s.reference("authors", { embed: true }) }),
  transform: ({ author, ...rest }) => ({ ...rest, writer: author }),
});
export default defineConfig({ content: [authors, posts] });`,
      "authors/ada.yml": "name: Ada\n",
      "posts/a.md": "---\nauthor: nobody\n---\n",
    });
    expect(diagnostics.map((d) => [d.code, d.fieldPath])).toEqual([
      ["reference-failed", ["author"]],
    ]);
  });

  it("checks references behind z.preprocess() and inside recursive schemas", async () => {
    const diagnostics = await diagnosticsOf({
      "anhur.config.ts": `${header}
const Node = s.object({
  author: s.reference("authors"),
  get children() { return s.array(Node).optional(); },
});
const posts = defineCollection({
  name: "posts", directory: "posts", include: "*.md",
  schema: s.object({
    editor: s.preprocess((value) => typeof value === "string" ? value.trim() : value, s.reference("authors")),
    tree: Node,
  }),
});
export default defineConfig({ content: [authors, posts] });`,
      "authors/ada.yml": "name: Ada\n",
      "posts/a.md":
        "---\neditor: ' nobody '\ntree:\n  author: ada\n  children:\n    - author: ada\n      children:\n        - author: ghost\n---\n",
    });
    expect(diagnostics.map((d) => [d.code, d.fieldPath])).toEqual([
      ["reference-failed", ["editor"]],
      ["reference-failed", ["tree", "children", 0, "children", 0, "author"]],
    ]);
  });

  it("computes fields inside defaulted containers", async () => {
    const site = await project({
      "anhur.config.ts": `${header}
const pages = defineCollection({
  name: "pages", directory: "pages", include: "*.md",
  schema: s.object({
    seo: s.object({ slug: s.slug(), words: s.metadata() }).default({}),
    extra: s.object({ slug: s.slug({ unique: false }) }).prefault({}),
  }),
});
export default defineConfig({ content: [authors, pages] });`,
      "authors/ada.yml": "name: Ada\n",
      "pages/about-us.md": "Hello there\n",
    });
    await build({ rootDir: site.dir });
    const generated = await importGenerated(site.dir);
    const page = await getter(generated, "getPage", { id: "about-us" });
    expect(page?.seo).toEqual({
      slug: "about-us",
      words: { readingTime: 1, wordCount: 2 },
    });
    expect(page?.extra).toEqual({ slug: "about-us" });
  });

  it("derives slugs for the root index and asks for one when letters cannot be spelled in ASCII", async () => {
    const site = await project({
      "anhur.config.ts": `${header}
const pages = defineCollection({
  name: "pages", directory: "pages", include: "**/*.md",
  schema: s.object({ slug: s.slug({ removeIndex: true }) }),
});
const home = defineCollection({
  name: "home", directory: "home", include: "*.md",
  schema: s.object({ slug: s.slug({ removeIndex: true, pattern: /^[a-z0-9-]*$/ }) }),
});
export default defineConfig({ content: [authors, pages, home] });`,
      "authors/ada.yml": "name: Ada\n",
      "pages/index.md": "Home\n",
      "pages/Straße/index.md": "Street\n",
      "home/index.md": "Home\n",
    });
    await build({ rootDir: site.dir });
    const generated = await importGenerated(site.dir);
    expect(
      rows(generated, "allPages")
        .map((row) => String(row.slug))
        .sort(),
    ).toEqual(["index", "strasse"]);
    expect(rows(generated, "allHomes").map((row) => row.slug)).toEqual([""]);

    const diagnostics = await diagnosticsOf({
      "anhur.config.ts": `${header}
const pages = defineCollection({ name: "pages", directory: "pages", include: "*.md", schema: s.object({ slug: s.slug() }) });
export default defineConfig({ content: [authors, pages] });`,
      "authors/ada.yml": "name: Ada\n",
      "pages/你好.md": "Hi\n",
    });
    expect(diagnostics.map((d) => d.code)).toEqual(["field-failed"]);
    expect(diagnostics[0]?.message).toContain("no ASCII spelling");
  });
});
