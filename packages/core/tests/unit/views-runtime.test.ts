import { describe, expect, it } from "vitest";
import {
  defineCollection,
  defineGroup,
  defineIndex,
  defineView,
} from "../../src/config";
import { schema as s } from "../../src/schema";
import {
  resolveGroupEntries,
  resolveIndexRecord,
  resolveViewListItems,
  type ViewBuiltSource,
} from "../../src/views";

const meta = {
  id: "a",
  filePath: "/a.md",
  relativePath: "a.md",
  extension: ".md",
};

function source(
  name: string,
  documents: ViewBuiltSource["documents"],
): ViewBuiltSource {
  const collection = defineCollection({
    name,
    directory: `content/${name}`,
    include: "**/*.md",
    schema: s.object({
      title: s.string(),
      slug: s.string(),
      body: s.string(),
      sku: s.string().optional(),
      category: s.string().optional(),
    }),
  });
  return { source: collection, documents };
}

describe("view projection", () => {
  it("runs select() on the full document including omitted list fields", () => {
    const posts = defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      schema: s.object({
        title: s.string(),
        slug: s.string(),
        body: s.string(),
      }),
    });
    const view = defineView({
      name: "excerpts",
      from: posts,
      select: (doc) => ({
        slug: doc.slug,
        excerpt: doc.body.slice(0, 5),
      }),
    });
    const built = [
      source("posts", [
        {
          data: { title: "T", slug: "t", body: "HELLO WORLD" },
          _meta: { ...meta, id: "t" },
        },
      ]),
    ];

    const items = resolveViewListItems(view, built, "/");
    expect(items).toEqual([{ slug: "t", excerpt: "HELLO" }]);
  });

  it("detects duplicate index keys before applying generate.limit", () => {
    const products = defineCollection({
      name: "products",
      directory: "content/products",
      include: "**/*.json",
      localized: false,
      schema: s.object({
        sku: s.string(),
        name: s.string(),
      }),
    });
    const index = defineIndex({
      name: "bySku",
      from: products,
      key: "sku",
      generate: { limit: 1 },
    });
    const built: ViewBuiltSource[] = [
      {
        source: products,
        documents: [
          {
            data: { sku: "PRO", name: "A" },
            _meta: { ...meta, id: "a" },
          },
          {
            data: { sku: "PRO", name: "B" },
            _meta: { ...meta, id: "b" },
          },
        ],
      },
    ];

    expect(() => resolveIndexRecord(index, built, "/")).toThrow(
      /duplicate key/,
    );
  });

  it("keeps group count as the pre-limit bucket size", () => {
    const products = defineCollection({
      name: "products",
      directory: "content/products",
      include: "**/*.json",
      localized: false,
      schema: s.object({
        sku: s.string(),
        category: s.string(),
      }),
    });
    const group = defineGroup({
      name: "byCategory",
      from: products,
      by: "category",
      generate: { limit: 1 },
    });
    const built: ViewBuiltSource[] = [
      {
        source: products,
        documents: [
          {
            data: { sku: "A", category: "pro" },
            _meta: { ...meta, id: "a" },
          },
          {
            data: { sku: "B", category: "pro" },
            _meta: { ...meta, id: "b" },
          },
        ],
      },
    ];

    const groups = resolveGroupEntries(group, built, "/");
    expect(groups).toEqual([
      {
        key: "pro",
        count: 2,
        items: [{ sku: "A", category: "pro", _meta: expect.any(Object) }],
      },
    ]);
  });
});
