/**
 * Type tests (checked by `tsc -p tsconfig.tests.json`, never run): typed hit
 * stores, exact `index()` results, optional values and query fields.
 */
import {
  defineCollection,
  defineConfig,
  schema as s,
  type AnhurConfig,
} from "@anhur/core";
import { orama, type SearchStoresOf } from "../../src";
import type { AnhurSearchIndex, SearchQuery } from "../../src/client";

const posts = defineCollection({
  name: "posts",
  directory: "posts",
  include: "*.md",
  schema: s.object({
    title: s.string(),
    summary: s.string().optional(),
    tags: s.array(s.string()),
    views: s.number(),
  }),
});
const pages = defineCollection({
  name: "pages",
  directory: "pages",
  include: "*.md",
  schema: s.object({ title: s.string() }),
});
const content = [posts, pages] as const;

const config = defineConfig({
  content,
  plugins: [
    { name: "other" },
    orama({
      collections: {
        posts: {
          schema: { title: "string", summary: "string", tags: "string[]" },
          // Optional values: `undefined` leaves the field out.
          index: (doc) => ({
            title: doc.title,
            summary: doc.summary,
            tags: doc.tags,
          }),
          store: (doc) => ({
            title: doc.title,
            summary: doc.summary,
            views: doc.views,
            meta: { tags: doc.tags },
          }),
        },
        pages: {
          schema: { title: "string" },
          index: (doc) => ({ title: doc.title }),
        },
      },
    }),
  ],
});

type Stores = SearchStoresOf<typeof config, "posts" | "pages">;
type PostStore = Stores["posts"];

export const typedStore: PostStore = {
  title: "Hello",
  views: 1,
  meta: { tags: ["a"] },
};
export const optionalSummary: PostStore["summary"] = undefined;
export const noStore: Stores["pages"] = {};
// @ts-expect-error `title` is a string
export const wrongTitle: PostStore = { title: 1, views: 1, meta: { tags: [] } };
// @ts-expect-error `views` is required
export const missingViews: PostStore = { title: "x", meta: { tags: [] } };

// Without the plugins tuple (a config typed `AnhurConfig`): JSON per collection.
type Fallback = SearchStoresOf<AnhurConfig, "posts">;
export const fallback: Fallback = { posts: { anything: [1, "two"] } };

// A config with only one collection searched.
const current = defineConfig({
  content,
  plugins: [
    orama({
      collections: {
        pages: {
          schema: { title: "string" },
          index: (doc) => ({ title: doc.title }),
          store: (doc) => ({ title: doc.title }),
        },
      },
    }),
  ],
});
export const currentTitle: SearchStoresOf<typeof current, "pages">["pages"] = {
  title: "x",
};

defineConfig({
  content,
  plugins: [
    orama({
      collections: {
        pages: {
          schema: { title: "string" },
          // @ts-expect-error `extra` is not in the schema
          index: (doc) => ({ title: doc.title, extra: 1 }),
        },
      },
    }),
  ],
});

defineConfig({
  content,
  plugins: [
    orama({
      collections: {
        posts: {
          schema: { title: "string", summary: "string" },
          // @ts-expect-error `summary` is missing
          index: (doc) => ({ title: doc.title }),
        },
      },
    }),
  ],
});

defineConfig({
  content,
  plugins: [
    orama({
      collections: {
        pages: {
          schema: { title: "string" },
          index: (doc) => ({ title: doc.title }),
          // @ts-expect-error a Date is not JSON
          store: () => ({ when: new Date() }),
        },
      },
    }),
  ],
});

defineConfig({
  content,
  plugins: [
    orama({
      collections: {
        pages: {
          // @ts-expect-error field names cannot contain "."
          schema: { "a.b": "string" },
          index: () => ({ "a.b": "x" }),
        },
      },
    }),
  ],
});

defineConfig({
  content,
  plugins: [
    orama({
      collections: {
        // @ts-expect-error `nope` is not a collection
        nope: { schema: { title: "string" }, index: () => ({ title: "x" }) },
      },
    }),
  ],
});

defineConfig({
  content,
  plugins: [
    orama({
      collections: {
        pages: {
          schema: { title: "string" },
          index: (doc) => ({ title: doc.title }),
        },
      },
      // @ts-expect-error not a stemming language
      languages: { default: "klingon" },
    }),
  ],
});

// Query fields are the index's string fields.
type Query = SearchQuery<Stores, "title" | "summary">;
export const query: Query = {
  term: "x",
  collection: ["posts"],
  properties: ["title"],
  boost: { summary: 2 },
};
// @ts-expect-error `collection` is not a searchable field
export const badProperty: Query = { term: "x", properties: ["collection"] };
// @ts-expect-error `views` is not a searchable field
export const badBoost: Query = { term: "x", boost: { views: 2 } };
// @ts-expect-error unknown collection
export const badCollection: Query = { term: "x", collection: "nope" };

export type IndexFields = AnhurSearchIndex<Stores, "title">["searchProperties"];
