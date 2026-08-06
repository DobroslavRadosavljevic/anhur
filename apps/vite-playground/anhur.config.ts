import {
  defineCollection,
  defineConfig,
  defineSingleton,
  getDocumentMeta,
  schema as s,
} from "@anhur/core";
import { assets, schema as a } from "@anhur/assets";
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

/** Public URL prefix for hashed files when uploading (path-style MinIO). */
const cdnBase = `${minioEndpoint}/${minioBucket}/${storagePrefix}/`;

/** Monolingual YAML authors (`localized: false`). */
const authors = defineCollection({
  name: "authors",
  directory: "content/authors",
  include: "**/*.{yml,yaml}",
  localized: false,
  generate: {
    listOmit: [],
  },
  schema: s.object({
    name: s.string(),
    role: s.string(),
    bio: s.string(),
    avatar: a.image().optional(),
  }),
});

/** Localized MDX posts — cover, reference→author, body rewrite, permalink. */
const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.{md,mdx}",
  generate: {
    emitIds: true,
    emitSlugs: true,
  },
  schema: s
    .object({
      title: s.string(),
      slug: s.slug(),
      summary: s.string().optional(),
      publishedAt: s.isodate().optional(),
      draft: s.boolean().optional(),
      author: s.reference("authors", { embed: true }),
      cover: a.image().optional(),
      attachment: a.file().optional(),
      remoteCover: a.image().optional(),
      excerpt: s.excerpt({ length: 120 }),
      metadata: s.metadata(),
      toc: s.toc({ maxDepth: 3 }),
      body: m.mdx(),
    })
    .transform((data) => {
      const meta = getDocumentMeta();
      return {
        ...data,
        permalink: `/posts/${meta.locale ?? "default"}/${data.slug}`,
      };
    }),
  transform: (doc, ctx) => {
    if (doc.draft === true) return ctx.skip("draft");
    const authorCount = ctx.documents(authors).length;
    return {
      ...doc,
      authorCatalogSize: authorCount,
    };
  },
});

/** Localized Markdown→HTML pages. */
const pages = defineCollection({
  name: "pages",
  directory: "content/pages",
  include: "**/*.md",
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    body: md.markdown(),
  }),
});

/** Localized site settings singleton. */
const settings = defineSingleton({
  name: "settings",
  directory: "content/settings",
  include: "index.{md,mdx}",
  generate: {
    variantsName: "allSettings",
  },
  schema: s.object({
    siteName: s.string(),
    tagline: s.string(),
    body: s.raw(),
  }),
});

/** Monolingual JSON products — list-only (no lazy documents). */
const products = defineCollection({
  name: "products",
  directory: "content/products",
  include: "**/*.json",
  localized: false,
  generate: {
    split: "list-only",
    listOmit: [],
    lookupBy: ["sku"],
    emitIds: true,
  },
  schema: s.object({
    name: s.string(),
    sku: s.unique(),
    price: s.string(),
    brochure: a.file().optional(),
  }),
});

/** Monolingual Markdown changelog. */
const changelog = defineCollection({
  name: "changelog",
  directory: "content/changelog",
  include: "**/*.md",
  localized: false,
  generate: {
    listSort: { by: "date", order: "desc" },
    emitIds: true,
  },
  schema: s.object({
    title: s.string(),
    date: s.isodate(),
    body: md.markdown(),
  }),
});

/** Monolingual about singleton via `filePath`. */
const about = defineSingleton({
  name: "about",
  filePath: "content/about.md",
  localized: false,
  generate: {
    split: "list-only",
  },
  schema: s.object({
    title: s.string(),
    body: s.raw(),
  }),
});

export default defineConfig({
  localization: {
    strategy: "folder",
    locales: ["en", "de"],
    defaultLocale: "en",
  },
  processors: [
    mdx({ gfm: true }),
    markdown({ gfm: true }),
    assets({
      dir: ".anhur/assets",
      base: uploadAssets ? cdnBase : "/anhur-assets/",
      storage: uploadAssets
        ? {
            enabled: true,
            prefix: storagePrefix,
            prune: true,
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
        : { enabled: false },
    }),
  ],
  content: [authors, posts, pages, settings, products, changelog, about],
  integrations: [
    orama({
      collections: {
        posts: {
          schema: {
            title: "string",
            summary: "string",
            excerpt: "string",
          },
          index: (doc) => ({
            title: doc.title,
            summary: doc.summary ?? "",
            excerpt: doc.excerpt ?? "",
          }),
          store: (doc) => ({
            title: doc.title,
            slug: doc.slug,
            summary: doc.summary ?? doc.excerpt ?? "",
            href: doc.permalink ?? `/posts/${doc._meta.locale}/${doc.slug}`,
            authorName: doc.author.name,
          }),
        },
        pages: {
          schema: {
            title: "string",
          },
          index: (doc) => ({
            title: doc.title,
          }),
          store: (doc) => ({
            title: doc.title,
            slug: doc.slug,
            href: `/pages/${doc._meta.locale}/${doc.slug}`,
          }),
        },
        products: {
          schema: {
            name: "string",
            sku: "string",
          },
          index: (doc) => ({
            name: doc.name,
            sku: doc.sku,
          }),
          store: (doc) => ({
            name: doc.name,
            sku: doc.sku,
            price: doc.price,
            href: "/products",
          }),
        },
        changelog: {
          schema: {
            title: "string",
          },
          index: (doc) => ({
            title: doc.title,
          }),
          store: (doc) => ({
            title: doc.title,
            date: doc.date,
            href: "/changelog",
          }),
        },
      },
    }),
  ],
});
