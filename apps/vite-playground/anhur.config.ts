import {
  createDerivedHelpers,
  defineCollection,
  defineConfig,
  defineSingleton,
  schema as s,
} from "@anhur/core";
import { assets, DEFAULT_ASSET_EXTENSIONS, schema as a } from "@anhur/assets";
import { markdown, schema as md } from "@anhur/markdown";
import { mdx, schema as m } from "@anhur/mdx";
import { orama } from "@anhur/orama";
import { Files } from "files-sdk";
import { minio } from "files-sdk/minio";

/** Set `ANHUR_ASSETS_UPLOAD=1` after `docker compose -f docker-compose.minio.yml up`. */
const uploadAssets = process.env.ANHUR_ASSETS_UPLOAD === "1";

const minioEndpoint = process.env.MINIO_ENDPOINT ?? "http://127.0.0.1:9000";
const minioBucket = process.env.MINIO_BUCKET ?? "anhur-assets";
const storagePrefix = "playground";

/** Monolingual YAML authors (`localized: false`). */
const authors = defineCollection({
  name: "authors",
  directory: "content/authors",
  include: "**/*.{yml,yaml}",
  localized: false,
  generate: { listOmit: [] },
  schema: s.object({
    name: s.string(),
    role: s.string(),
    bio: s.string(),
    avatar: a.image().optional(),
  }),
});

/** Localized MDX posts: cover, embedded author, body assets, permalink. */
const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.{md,mdx}",
  generate: { emitIds: true, emitSlugs: true },
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    summary: s.string().optional(),
    publishedAt: s.isodate().optional(),
    draft: s.boolean().optional(),
    author: s.reference("authors", { embed: true }),
    cover: a.image().optional(),
    attachment: a.file().optional(),
    remoteCover: a.image({ allowRemote: true }).optional(),
    excerpt: s.excerpt({ length: 120 }),
    metadata: s.metadata(),
    toc: s.toc({ maxDepth: 3 }),
    body: m.body(),
  }),
  transform: (doc, ctx) => ({
    ...doc,
    permalink: `/posts/${doc._meta.locale}/${doc.slug}`,
    authorCatalogSize: ctx.documents(authors).length,
  }),
});

/** Localized Markdown → HTML pages. */
const pages = defineCollection({
  name: "pages",
  directory: "content/pages",
  include: "**/*.md",
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    body: md.body(),
  }),
});

/** Localized site settings singleton. */
const settings = defineSingleton({
  name: "settings",
  directory: "content/settings",
  generate: { variantsName: "allSettings" },
  schema: s.object({
    siteName: s.string(),
    tagline: s.string(),
    body: s.raw(),
  }),
});

/** Monolingual JSON products, list-only (no lazy documents). */
const products = defineCollection({
  name: "products",
  directory: "content/products",
  include: "**/*.json",
  localized: false,
  generate: { split: "list-only", listOmit: [], emitIds: true },
  schema: s.object({
    name: s.string(),
    sku: s.unique(),
    price: s.string(),
    featured: s.boolean().optional(),
    category: s.string().optional(),
    brochure: a.file().optional(),
  }),
});

/** Monolingual Markdown changelog. */
const changelog = defineCollection({
  name: "changelog",
  directory: "content/changelog",
  include: "**/*.md",
  localized: false,
  generate: { listSort: { by: "date", order: "desc" }, emitIds: true },
  schema: s.object({
    title: s.string(),
    date: s.isodate({ output: "date" }),
    body: md.body(),
  }),
});

/** Monolingual about singleton via `filePath`. */
const about = defineSingleton({
  name: "about",
  filePath: "content/about.md",
  localized: false,
  generate: { split: "list-only" },
  schema: s.object({
    title: s.string(),
    body: s.raw(),
  }),
});

const content = [
  authors,
  posts,
  pages,
  settings,
  products,
  changelog,
  about,
] as const;
const { defineView, defineIndex, defineGroup } = createDerivedHelpers(content);

/** Featured products, sorted by price (build-time subset). */
const featuredProducts = defineView({
  name: "featuredProducts",
  from: products,
  where: (doc): doc is typeof doc & { featured: true } => doc.featured === true,
  generate: { listSort: { by: "price", order: "asc" }, limit: 12 },
});

/** SKU → product card for detail routes. */
const productBySku = defineIndex({
  name: "productBySku",
  from: products,
  key: "sku",
  select: (doc) => ({
    name: doc.name,
    sku: doc.sku,
    price: doc.price,
    featured: doc.featured === true,
  }),
});

/** Category facet pages. */
const productsByCategory = defineGroup({
  name: "productsByCategory",
  from: products,
  by: (doc) => doc.category ?? "uncategorized",
  select: (doc) => ({ name: doc.name, sku: doc.sku, price: doc.price }),
  generate: { listSort: { by: "name", order: "asc" } },
});

/** Posts by the author's name (uses the embedded author). */
const postsByAuthor = defineGroup({
  name: "postsByAuthor",
  from: posts,
  by: (doc) => doc.author.name,
  select: (doc) => ({ title: doc.title, href: doc.permalink }),
});

/** Mixed posts + pages card feed. */
const siteFeed = defineView({
  name: "siteFeed",
  from: [posts, pages],
  select: (doc) => ({
    collection: doc.collection,
    title: doc.title,
    slug: doc.slug,
    href:
      doc.collection === "posts"
        ? doc.permalink
        : `/pages/${doc._meta.locale}/${doc.slug}`,
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
  views: [
    featuredProducts,
    productBySku,
    productsByCategory,
    postsByAuthor,
    siteFeed,
  ],
  plugins: [
    mdx(),
    markdown(),
    assets({
      // notes.txt is linked from a post; text files are not assets by default.
      extensions: [...DEFAULT_ASSET_EXTENSIONS, ".txt"],
      base: uploadAssets
        ? `${minioEndpoint}/${minioBucket}/${storagePrefix}/`
        : "/anhur-assets/",
      storage: uploadAssets
        ? {
            prefix: storagePrefix,
            files: () =>
              new Files({
                adapter: minio({
                  bucket: minioBucket,
                  endpoint: minioEndpoint,
                  accessKeyId: process.env.MINIO_ACCESS_KEY_ID ?? "anhur",
                  secretAccessKey:
                    process.env.MINIO_SECRET_ACCESS_KEY ?? "anhursecret",
                  publicBaseUrl: `${minioEndpoint}/${minioBucket}`,
                }),
              }),
          }
        : undefined,
    }),
    orama({
      collections: {
        posts: {
          schema: { title: "string", summary: "string", excerpt: "string" },
          index: (doc) => ({
            title: doc.title,
            summary: doc.summary,
            excerpt: doc.excerpt,
          }),
          store: (doc) => ({
            title: doc.title,
            summary: doc.summary ?? doc.excerpt,
            href: doc.permalink,
            authorName: doc.author.name,
          }),
        },
        pages: {
          schema: { title: "string" },
          index: (doc) => ({ title: doc.title }),
          store: (doc) => ({
            title: doc.title,
            href: `/pages/${doc._meta.locale}/${doc.slug}`,
          }),
        },
        products: {
          schema: { name: "string", sku: "string" },
          index: (doc) => ({ name: doc.name, sku: doc.sku }),
          store: (doc) => ({
            title: doc.name,
            sku: doc.sku,
            price: doc.price,
            href: "/products",
          }),
        },
        changelog: {
          schema: { title: "string" },
          index: (doc) => ({ title: doc.title }),
          store: (doc) => ({
            title: doc.title,
            date: doc.date,
            href: "/changelog",
          }),
        },
      },
      languages: { en: "english", de: "german" },
    }),
  ],
});
