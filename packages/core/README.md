# `@anhur/core`

❤️ The heart of Anhur.

It reads content files from your repo (Markdown, MDX, YAML, JSON), checks them against schemas you write, and generates typed modules your app can import.

## 📦 Install

```sh
bun add @anhur/core
```

This also installs the **`anhur` CLI** (`anhur build`, `anhur watch`). After install you can run it from your project scripts or via `bunx anhur` / `npx anhur`.

## ✨ What you get

- `defineConfig` / `defineCollection` / `defineSingleton` — describe your content
- `defineView` / `defineIndex` / `defineGroup` — build-time derived lists, maps, and groups
- `schema` helpers — fields like strings, dates, unique slugs, and references
- `anhur` CLI — included with this package; no separate install

Optional extras live in other packages:

- MDX bodies → [`@anhur/mdx`](https://www.npmjs.com/package/@anhur/mdx)
- Markdown → HTML → [`@anhur/markdown`](https://www.npmjs.com/package/@anhur/markdown)
- Images and files (optional CDN sync) → [`@anhur/assets`](https://www.npmjs.com/package/@anhur/assets)
- Full-text search → [`@anhur/orama`](https://www.npmjs.com/package/@anhur/orama)
- Vite integration → [`@anhur/vite`](https://www.npmjs.com/package/@anhur/vite)

## 🚀 Quick example

`anhur.config.ts`:

```ts
import {
  defineCollection,
  defineConfig,
  defineGroup,
  defineIndex,
  defineView,
  schema as s,
} from "@anhur/core";

const products = defineCollection({
  name: "products",
  directory: "content/products",
  include: "**/*.json",
  localized: false,
  generate: { split: "list-only", listOmit: [] },
  schema: s.object({
    name: s.string(),
    sku: s.unique(),
    category: s.string(),
    featured: s.boolean().optional(),
    price: s.string(),
  }),
});

const featuredProducts = defineView({
  name: "featuredProducts",
  from: products,
  where: (doc): doc is typeof doc & { featured: true } => doc.featured === true,
  generate: { limit: 12 },
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
});

export default defineConfig({
  content: [products],
  views: [featuredProducts, productBySku, productsByCategory],
});
```

Build:

```sh
anhur build
```

Then import the generated data (with `@anhur/vite`, the import path is `anhur/generated`):

```ts
import {
  allProducts,
  allFeaturedProducts,
  productBySku,
  productsByCategory,
} from "anhur/generated";

productBySku["W-100"]?.price;
productsByCategory.find((g) => g.key === "widgets")?.items;
```

## Derived exports (`views`)

| Helper        | Emits                     | Best for                        |
| ------------- | ------------------------- | ------------------------------- |
| `defineView`  | `T[]`                     | featured / top-N / merged feeds |
| `defineIndex` | `Record<Key, T>`          | detail lookup by slug/sku       |
| `defineGroup` | `{ key, count, items }[]` | facet / SEO landing pages       |

- Run after transforms / `prepare`
- List-only (no getters / `documents/` modules)
- `where` / `select` get `(doc, ctx)` — use `ctx.documents(otherCollection)` for joins
- `generate.limit` / `compare` / `listSort` for top-N and sorting
- Indexes and groups emit **literal key unions** in `.d.ts` (e.g. `ProductBySkuKey`)

## 💡 Tips

- Put one collection (or singleton) per content type — posts, authors, settings, and so on
- Plural folder names are fine: `use_cases` → `UseCase`, `getUseCase`, `allUseCases`. Set `typeName` on `defineCollection` when you need a different document type (not under `generate`)
- Use folders like `content/posts/en/` and `content/posts/de/` when you need multiple languages
- List pages can use the light list (`allPosts`); detail pages can load one full document with `getPost("slug")` or `getPost({ slug })` (returns `null` if missing)
- Prefer `defineIndex` over filtering a huge `allProducts` for detail routes when using `list-only`
- For `by` / `where` / `select` that read `embed: true` fields, pass `content` or use `createDerivedHelpers(content)` so TypeScript remaps embeds like collection exports
- Light lists omit configured fields (default `body`) from the row **and** from nested embeds
- Each successful build replaces the generate output folder (via a staging swap), so renamed or removed collections do not leave stale modules — and a failed rebuild leaves the previous live output intact

## License

MIT
