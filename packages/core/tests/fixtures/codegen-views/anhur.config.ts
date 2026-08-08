import {
  defineCollection,
  defineConfig,
  defineGroup,
  defineIndex,
  defineView,
  schema as s,
} from "../../../src/index";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: s.object({
    title: s.string(),
    slug: s.string(),
    featured: s.boolean().optional(),
    body: s.string(),
  }),
});

const pages = defineCollection({
  name: "pages",
  directory: "content/pages",
  include: "**/*.md",
  schema: s.object({
    title: s.string(),
    slug: s.string(),
    body: s.string(),
  }),
});

const products = defineCollection({
  name: "products",
  directory: "content/products",
  include: "**/*.json",
  localized: false,
  generate: {
    split: "list-only",
    listOmit: [],
  },
  schema: s.object({
    name: s.string(),
    sku: s.string(),
    featured: s.boolean().optional(),
    category: s.string(),
    price: s.string(),
  }),
});

const featuredPosts = defineView({
  name: "featuredPosts",
  from: posts,
  where: (doc): doc is typeof doc & { featured: true } => doc.featured === true,
});

const featuredProducts = defineView({
  name: "featuredProducts",
  from: products,
  where: (doc) => doc.featured === true,
  generate: {
    listName: "spotlightProducts",
    compare: (a, b) => Number(a.price) - Number(b.price),
    limit: 1,
  },
});

const siteFeed = defineView({
  name: "siteFeed",
  from: [posts, pages],
  select: (doc) => ({
    collection: doc.collection,
    title: doc.title,
    slug: doc.slug,
    href:
      doc.collection === "posts" ? `/posts/${doc.slug}` : `/pages/${doc.slug}`,
  }),
  generate: {
    listName: "allSiteFeed",
    listSort: { by: "title", order: "asc" },
  },
});

const productBySku = defineIndex({
  name: "productBySku",
  from: products,
  key: "sku",
  select: (doc) => ({
    name: doc.name,
    sku: doc.sku,
    price: doc.price,
  }),
});

const productsByCategory = defineGroup({
  name: "productsByCategory",
  from: products,
  by: "category",
  select: (doc) => ({
    name: doc.name,
    sku: doc.sku,
    price: doc.price,
  }),
  generate: {
    compare: (a, b) => Number(a.price) - Number(b.price),
  },
});

export default defineConfig({
  localization: {
    strategy: "folder",
    locales: ["en"],
    defaultLocale: "en",
  },
  content: [posts, pages, products],
  views: [
    featuredPosts,
    featuredProducts,
    siteFeed,
    productBySku,
    productsByCategory,
  ],
});
