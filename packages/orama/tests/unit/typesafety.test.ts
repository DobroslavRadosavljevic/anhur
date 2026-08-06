import {
  defineCollection,
  defineConfig,
  defineSingleton,
  schema as s,
} from "@anhur/core";
import { describe, expectTypeOf, it } from "vitest";
import { orama } from "../../src";
import type { SearchDocument } from "../../src/types";

const authors = defineCollection({
  name: "authors",
  directory: "content/authors",
  include: "**/*.yml",
  localized: false,
  schema: s.object({
    name: s.string(),
    role: s.string(),
  }),
});

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  localized: false,
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    summary: s.string().optional(),
    author: s.reference("authors", { embed: true }),
  }),
  transform: (doc) => ({
    ...doc,
    permalink: `/posts/${doc.slug}`,
  }),
});

const pages = defineCollection({
  name: "pages",
  directory: "content/pages",
  include: "**/*.md",
  localized: false,
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
  }),
});

const settings = defineSingleton({
  name: "settings",
  filePath: "content/settings.md",
  localized: false,
  schema: s.object({
    siteName: s.string(),
  }),
});

const content = [authors, posts, pages, settings] as const;

describe("orama integration typing via defineConfig", () => {
  it("types SearchDocument from the content array", () => {
    type PostDoc = SearchDocument<typeof content, "posts">;
    expectTypeOf<PostDoc["title"]>().toEqualTypeOf<string>();
    expectTypeOf<PostDoc["permalink"]>().toEqualTypeOf<string>();
    expectTypeOf<PostDoc["author"]>().toMatchTypeOf<{
      name: string;
      role: string;
      _meta: { id: string };
    }>();
  });

  it("types index/store docs from inline config content", () => {
    defineConfig({
      content: [authors, posts, pages, settings],
      integrations: [
        orama({
          collections: {
            posts: {
              schema: {
                title: "string",
                summary: "string",
              },
              index: (doc) => {
                expectTypeOf(doc.title).toEqualTypeOf<string>();
                expectTypeOf(doc.slug).toEqualTypeOf<string>();
                expectTypeOf(doc.permalink).toEqualTypeOf<string>();
                expectTypeOf(doc.author.name).toEqualTypeOf<string>();
                return {
                  title: doc.title,
                  summary: doc.summary ?? "",
                };
              },
              store: (doc) => ({
                title: doc.title,
                href: doc.permalink,
                authorName: doc.author.name,
              }),
            },
            pages: {
              schema: { title: "string" },
              index: (doc) => {
                expectTypeOf(doc.title).toEqualTypeOf<string>();
                expectTypeOf(doc.slug).toEqualTypeOf<string>();
                return { title: doc.title };
              },
            },
          },
        }),
      ],
    });
  });

  it("rejects unknown collection keys and singleton names", () => {
    defineConfig({
      content: [authors, posts, pages, settings],
      integrations: [
        orama({
          collections: {
            posts: {
              schema: { title: "string" },
              index: (doc) => ({ title: doc.title }),
            },
            // @ts-expect-error — not a collection name in content
            missing: {
              schema: { title: "string" },
              index: () => ({ title: "x" }),
            },
          },
        }),
      ],
    });

    defineConfig({
      content: [authors, posts, pages, settings],
      integrations: [
        orama({
          collections: {
            posts: {
              schema: { title: "string" },
              index: (doc) => ({ title: doc.title }),
            },
            // @ts-expect-error — singletons are not searchable collections
            settings: {
              schema: { title: "string" },
              index: () => ({ title: "x" }),
            },
          },
        }),
      ],
    });
  });

  it("rejects unknown document fields on typed callbacks", () => {
    defineConfig({
      content: [authors, posts, pages, settings],
      integrations: [
        orama({
          collections: {
            posts: {
              schema: { title: "string" },
              index: (doc) => {
                // @ts-expect-error — posts have no `sku` field
                const _sku = doc.sku;
                return { title: doc.title };
              },
              store: (doc) => {
                // @ts-expect-error — posts have no `price` field
                const _price = doc.price;
                return { title: doc.title };
              },
            },
          },
        }),
      ],
    });
  });
});
