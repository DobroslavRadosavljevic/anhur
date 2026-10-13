import {
  createDerivedHelpers,
  defineCollection,
  defineConfig,
  schema as s,
} from "@anhur/core";
import { assets, schema as a } from "@anhur/assets";
import { markdown, schema as md } from "@anhur/markdown";
import { mdx, schema as m } from "@anhur/mdx";
import { orama } from "@anhur/orama";

/**
 * Benchmark project: the shape of a mid-sized content site. `src/run.ts`
 * copies this file next to the generated `content/` folder.
 */
const authors = defineCollection({
  name: "authors",
  directory: "content/authors",
  include: "**/*.yml",
  localized: false,
  generate: { listOmit: [] },
  schema: s.object({
    name: s.string(),
    role: s.string(),
    bio: s.string(),
    avatar: a.image().optional(),
  }),
});

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.mdx",
  generate: { emitIds: true, emitSlugs: true },
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    summary: s.string().optional(),
    publishedAt: s.isodate(),
    tags: s.array(s.string()),
    author: s.reference("authors", { embed: true }),
    cover: a.image().optional(),
    excerpt: s.excerpt({ length: 160 }),
    metadata: s.metadata(),
    toc: s.toc({ maxDepth: 3 }),
    body: m.body(),
  }),
  transform: (doc) => ({
    ...doc,
    permalink: `/posts/${doc._meta.locale}/${doc.slug}`,
  }),
});

const pages = defineCollection({
  name: "pages",
  directory: "content/pages",
  include: "**/*.md",
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    toc: s.toc(),
    body: md.body(),
  }),
});

const products = defineCollection({
  name: "products",
  directory: "content/products",
  include: "**/*.json",
  localized: false,
  generate: { split: "list-only", listOmit: [], emitIds: true },
  schema: s.object({
    name: s.string(),
    sku: s.unique(),
    price: s.number(),
    featured: s.boolean().optional(),
    category: s.string(),
  }),
});

const content = [authors, posts, pages, products] as const;
const { defineView, defineIndex, defineGroup } = createDerivedHelpers(content);

const featuredProducts = defineView({
  name: "featuredProducts",
  from: products,
  where: (doc) => doc.featured === true,
  generate: { listSort: { by: "price", order: "asc" }, limit: 24 },
});

const productBySku = defineIndex({
  name: "productBySku",
  from: products,
  key: "sku",
  select: (doc) => ({ name: doc.name, sku: doc.sku, price: doc.price }),
});

const postsByAuthor = defineGroup({
  name: "postsByAuthor",
  from: posts,
  by: (doc) => doc.author.name,
  select: (doc) => ({ title: doc.title, href: doc.permalink }),
});

const siteFeed = defineView({
  name: "siteFeed",
  from: [posts, pages],
  select: (doc) => ({
    collection: doc.collection,
    title: doc.title,
    slug: doc.slug,
  }),
  generate: {
    listName: "allSiteFeed",
    listSort: { by: "title", order: "asc" },
  },
});

export default defineConfig({
  localization: {
    strategy: "folder",
    locales: ["en", "de"],
    defaultLocale: "en",
  },
  content,
  views: [featuredProducts, productBySku, postsByAuthor, siteFeed],
  plugins: [
    mdx(),
    markdown(),
    assets({ base: "/anhur-assets/" }),
    orama({
      collections: {
        posts: {
          schema: { title: "string", summary: "string", excerpt: "string" },
          index: (doc) => ({
            title: doc.title,
            summary: doc.summary,
            excerpt: doc.excerpt,
          }),
          store: (doc) => ({ title: doc.title, href: doc.permalink }),
        },
        pages: {
          schema: { title: "string" },
          index: (doc) => ({ title: doc.title }),
          store: (doc) => ({ title: doc.title, slug: doc.slug }),
        },
      },
      languages: { en: "english", de: "german" },
    }),
  ],
});
