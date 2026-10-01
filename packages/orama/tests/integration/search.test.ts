import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { build, isAnhurBuildError } from "@anhur/core/build";
import { createSearcher, type AnhurSearchIndex } from "../../src/client";
import { createProject, type TestProject } from "../fixtures/temp-project";

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

type PostsSearch = {
  readonly index?: string;
  readonly store?: string;
  readonly schema?: string;
  readonly languages?: string;
};

const CONFIG = ({
  index = "(doc) => ({ title: doc.title, tags: doc.tags })",
  store = '(doc) => ({ title: doc.title, href: "/" + doc._meta.locale + "/" + doc._meta.id })',
  schema = '{ title: "string", tags: "string[]" }',
  languages = "undefined",
}: PostsSearch = {}) => `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { orama } from "@anhur/orama";

const posts = defineCollection({
  name: "posts",
  directory: "posts",
  include: "**/*.md",
  schema: s.object({
    title: s.string(),
    summary: s.string().optional(),
    tags: s.array(s.string()).default([]),
  }),
});
const products = defineCollection({
  name: "products",
  directory: "products",
  include: "*.yml",
  localized: false,
  schema: s.object({ name: s.string() }),
});

export default defineConfig({
  localization: { strategy: "folder", locales: ["en", "sr", "ja"], defaultLocale: "en" },
  content: [posts, products],
  plugins: [
    orama({
      collections: {
        posts: {
          schema: ${schema},
          index: ${index},
          store: ${store},
        },
        products: {
          schema: { name: "string" },
          index: (doc) => ({ name: doc.name }),
        },
      },
      languages: ${languages},
    }),
  ],
});
`;

const FILES = {
  "posts/en/hello.md": "---\ntitle: Hello world\ntags: [greeting]\n---\n",
  "posts/en/a:b.md": "---\ntitle: Colon id\n---\n",
  "posts/en/running.md":
    "---\ntitle: Running shoes\nsummary: Fast and light\n---\n",
  "posts/sr/zdravo.md": "---\ntitle: Здраво свете\n---\n",
  "posts/ja/tokyo.md": "---\ntitle: 東京タワーへようこそ\n---\n",
  "products/kit.yml": "name: Starter kit\n",
};

type SearchModule = {
  readonly loadSearchIndex: (locale?: string) => Promise<AnhurSearchIndex>;
};

async function loadModule(dir: string): Promise<SearchModule> {
  // SAFETY: the generated search module exports loadSearchIndex (asserted by use below).
  return (await import(
    pathToFileURL(`${dir}/.anhur/generated/search.js`).href
  )) as SearchModule;
}

async function buildProject(config: string): Promise<TestProject> {
  const project = await createProject({ "anhur.config.ts": config, ...FILES });
  projects.push(project);
  await build({ rootDir: project.dir });
  return project;
}

async function buildError(config: string): Promise<string> {
  const project = await createProject({ "anhur.config.ts": config, ...FILES });
  projects.push(project);
  const error = await build({ rootDir: project.dir }).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!isAnhurBuildError(error)) {
    throw new Error("expected the build to fail", { cause: error });
  }
  return error.message;
}

describe("orama plugin", () => {
  it("builds one index per locale that finds any script and includes monolingual content", async () => {
    const project = await buildProject(CONFIG());
    const search = await loadModule(project.dir);

    const sr = await createSearcher(await search.loadSearchIndex("sr"));
    const cyrillic = await sr.search({ term: "здраво" });
    expect(cyrillic.hits.map((hit) => hit.documentId)).toEqual(["zdravo"]);
    expect(
      (await sr.search({ term: "starter" })).hits.map((hit) => hit.collection),
    ).toEqual(["products"]);

    const ja = await createSearcher(await search.loadSearchIndex("ja"));
    expect((await ja.search({ term: "東京" })).count).toBe(1);
    // A word inside a compound (`東京タワー` is one ICU word).
    expect((await ja.search({ term: "タワー" })).count).toBe(1);
    expect((await ja.search({ term: "タワー", threshold: 0 })).count).toBe(1);

    const en = await createSearcher(await search.loadSearchIndex());
    const hello = await en.search({ term: "hello", collection: "posts" });
    expect(hello.hits[0]).toMatchObject({
      documentId: "hello",
      store: { title: "Hello world", href: "/en/hello" },
    });
    expect((await en.search({ term: "colon" })).hits[0]?.documentId).toBe(
      "a:b",
    );
    expect((await en.search({ term: "en" })).count).toBe(0);
    expect((await en.search({ term: "greeting" })).count).toBe(1);
  });

  it("finds nothing for an empty term and checks properties and boost", async () => {
    const project = await buildProject(CONFIG());
    const search = await loadModule(project.dir);
    const en = await createSearcher(await search.loadSearchIndex("en"));

    expect((await en.search({ term: "" })).count).toBe(0);
    expect((await en.search({ term: "   " })).count).toBe(0);
    expect((await en.search({ term: "  hello " })).count).toBe(1);
    expect(
      (await en.search({ term: "hello", boost: { title: 0, tags: 2 } })).count,
    ).toBe(1);
    await expect(
      en.search({ term: "hello", properties: ["collection"] }),
    ).rejects.toThrow(/"collection" is not a searchable string field/);
    await expect(
      en.search({ term: "hello", boost: { nope: 2 } }),
    ).rejects.toThrow(/boost has "nope"/);
    await expect(
      en.search({ term: "hello", boost: { title: -1 } }),
    ).rejects.toThrow(/positive number/);
  });

  it("stems per locale with languages (any supported language)", async () => {
    const project = await buildProject(
      CONFIG({ languages: '{ en: "english", sr: "serbian" }' }),
    );
    const search = await loadModule(project.dir);
    const en = await createSearcher(await search.loadSearchIndex("en"));
    expect((await en.search({ term: "run" })).hits[0]?.documentId).toBe(
      "running",
    );
    const sr = await createSearcher(await search.loadSearchIndex("sr"));
    expect((await sr.search({ term: "здраво" })).count).toBe(1);
    // Not stemmed: no entry in `languages`.
    const ja = await createSearcher(await search.loadSearchIndex("ja"));
    expect((await ja.search({ term: "タワー" })).count).toBe(1);
  });

  it("accepts undefined for optional index and store values", async () => {
    const project = await buildProject(
      CONFIG({
        schema: '{ title: "string", summary: "string" }',
        index: "(doc) => ({ title: doc.title, summary: doc.summary })",
        store: "(doc) => ({ title: doc.title, summary: doc.summary })",
      }),
    );
    const search = await loadModule(project.dir);
    const en = await createSearcher(await search.loadSearchIndex("en"));
    expect((await en.search({ term: "light" })).hits[0]?.store).toEqual({
      title: "Running shoes",
      summary: "Fast and light",
    });
    expect((await en.search({ term: "hello" })).hits[0]?.store).toEqual({
      title: "Hello world",
    });
    const dts = await project.read(".anhur/generated/index.d.ts");
    expect(dts).toContain(
      'export type AnhurSearchStores = __AnhurOramaStoresOf<typeof __AnhurConfig, "posts" | "products">;',
    );
    expect(dts).toContain(
      'export type AnhurSearchField = "title" | "summary" | "name";',
    );
  });

  it("fails the build when index() does not match the schema", async () => {
    expect(
      await buildError(
        CONFIG({
          index:
            "((doc) => ({ title: doc.tags.length, tags: doc.tags })) as never",
        }),
      ),
    ).toMatch(/orama: posts document ".+" \(posts\/en\/.+\.md\): .*"title"/);
    expect(
      await buildError(
        CONFIG({ index: "((doc) => ({ title: doc.title })) as never" }),
      ),
    ).toMatch(
      /orama: posts document ".+" \(.+\): index\(\) did not return "tags"/,
    );
    expect(
      await buildError(
        CONFIG({
          index:
            "((doc) => ({ title: doc.title, tags: doc.tags, extra: 1 })) as never",
        }),
      ),
    ).toMatch(/index\(\) returned "extra", which is not in the "posts" schema/);
  });

  it("rejects store values JSON cannot keep, naming the document", async () => {
    expect(
      await buildError(
        CONFIG({ store: "((doc) => ({ when: new Date(0) })) as never" }),
      ),
    ).toMatch(
      /orama: posts document ".+" \(posts\/.+\.md\): store\(\) returned a Date at store\.when/,
    );
    expect(
      await buildError(
        CONFIG({ store: "((doc) => ({ big: { n: 1n } })) as never" }),
      ),
    ).toMatch(
      /posts document ".+".*store\(\) returned a bigint at store\.big\.n/,
    );
  });

  it("rejects bad schemas and languages before indexing", async () => {
    expect(
      await buildError(
        CONFIG({
          schema: '{ "a.b": "string" } as never',
          index: '(() => ({ "a.b": "x" })) as never',
        }),
      ),
    ).toMatch(/field "a\.b" is not a valid name/);
    expect(
      await buildError(
        CONFIG({
          schema: '{ count: "number" } as never',
          index: "(() => ({ count: 1 })) as never",
        }),
      ),
    ).toMatch(/collection "posts" has no "string" or "string\[\]" field/);
    expect(
      await buildError(
        CONFIG({ languages: '{ english: "english" } as never' }),
      ),
    ).toMatch(
      /languages has the key "english", which is not a locale; use one of "en", "sr", "ja"/,
    );
    expect(
      await buildError(CONFIG({ languages: '{ en: "klingon" } as never' })),
    ).toMatch(
      /languages\.en is "klingon", which has no stemmer\. Use one of .*"german"/,
    );
  });
});
