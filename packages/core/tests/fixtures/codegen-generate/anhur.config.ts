import {
  defineCollection,
  defineConfig,
  defineSingleton,
  schema as s,
} from "../../../src/index";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  generate: {
    listName: "posts",
    getterName: "loadPost",
    listItemTypeName: "PostSummary",
    arrayTypeName: "PostList",
    listSort: { by: "date", order: "desc" },
    emitIds: true,
    emitSlugs: true,
    lookupBy: ["slug"],
  },
  schema: s.object({
    title: s.string(),
    slug: s.string(),
    date: s.string(),
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
    lookupBy: ["sku"],
    emitIds: true,
  },
  schema: s.object({
    name: s.string(),
    sku: s.string(),
    price: s.string(),
  }),
});

const inventory = defineCollection({
  name: "inventory",
  directory: "content/inventory",
  include: "**/*.json",
  localized: false,
  generate: {
    lookupBy: ["sku"],
    listOmit: [],
  },
  schema: s.object({
    name: s.string(),
    sku: s.string(),
  }),
});

const notes = defineCollection({
  name: "notes",
  directory: "content/notes",
  include: "**/*.md",
  localized: false,
  generate: {
    split: "full",
  },
  schema: s.object({
    title: s.string(),
    body: s.string(),
  }),
});

const settings = defineSingleton({
  name: "settings",
  directory: "content/settings",
  include: "index.md",
  generate: {
    variantsName: "allSettings",
    getterName: "loadSettings",
  },
  schema: s.object({
    title: s.string(),
    body: s.string(),
  }),
});

export default defineConfig({
  localization: {
    strategy: "folder",
    locales: ["en", "de"],
    defaultLocale: "en",
  },
  content: [posts, products, inventory, notes, settings],
});
