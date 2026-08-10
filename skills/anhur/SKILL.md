---
name: anhur
description: >-
  Build, review, debug, configure, migrate, teach, or plan Anhur typed content
  (@anhur/core, @anhur/vite, @anhur/mdx, @anhur/markdown, @anhur/assets,
  @anhur/orama). Use when integrating Anhur into an app, writing or changing
  anhur.config.ts, the cms/ module tree (collections, singletons, enums,
  objects, views, content.ts, content files), views (defineView / defineIndex /
  defineGroup / createDerivedHelpers), processors, integrations (orama /
  defineIntegration), Zod content schemas, folder i18n / localization,
  anhur/generated imports, localized getters/lists (_meta.locale), the Vite
  plugin, CLI build/watch, drafts/hooks, MDX/Markdown bodies, assets,
  CDN/object storage upload (assets storage + files-sdk), or full-text search —
  or when the user mentions Anhur, .anhur, cms/, folder i18n, or local
  MD/MDX/YAML/JSON content pipelines.
license: MIT
metadata:
  version: "0.0.12"
  packages: "@anhur/core,@anhur/vite,@anhur/mdx,@anhur/markdown,@anhur/assets,@anhur/orama"
---

# Anhur

## What it is

Anhur turns **files in your repo** (Markdown, MDX, YAML, JSON) into **typed data your app can import**, like `allPosts` and `getPost("hello")`.

At build time it:

1. Reads content from folders you configure
2. Validates each document with **Zod** schemas you write
3. Optionally compiles MDX/Markdown, copies images, resolves relations
4. Writes modules under `.anhur/generated`
5. Runs optional **integrations** (e.g. Orama search index)
6. Lets the app import generated modules as `anhur/generated`

Vite plugs this into `vite dev` / `vite build` via `@anhur/vite`. The `anhur` CLI does the same without Vite. Optional folder-based **i18n** (`content/posts/en/…`, `de/…`). Local content as typed code — not a hosted CMS.

More framing: [references/why.md](references/why.md)

## Why you need it

Without something like Anhur, teams usually:

- Hand-parse Markdown in routes (no shared schema, easy to drift)
- Keep content in a CMS (network, auth, preview complexity) when files in git would do
- Copy-paste front matter shapes across pages with no compile-time checks
- Bolt on i18n later as a second system

Anhur is for when content **lives in the repo**, authors edit files, and the app should treat that content as **typed, validated modules** — lists, getters, relations, drafts, assets, search — with one config file.

## What it is for

| Use                        | Example                                                 |
| -------------------------- | ------------------------------------------------------- |
| Blogs / docs / changelogs  | MDX posts, Markdown pages, YAML authors                 |
| Marketing / product sites  | Localized pages + site settings singleton               |
| Catalogs / structured data | JSON products with unique SKUs and file attachments     |
| Directories / SEO facets   | `defineView` / `defineIndex` / `defineGroup` at build   |
| Multi-locale sites         | Same collection under `en/` / `de/` folders             |
| In-app full-text search    | Orama index over one or many collections                |
| CDN-delivered assets       | Build-time upload via `assets({ storage })` + files-sdk |

**Not for (today):** remote CMS as the source of truth, Next-only adapters, browser/signed media uploads (runtime media library), non-Zod schema libraries, vector / AI search.

## When to use this skill

- Explain Anhur to a user or choose it vs CMS / hand loaders
- Greenfield or migrate a site/app onto Anhur content
- Scaffold or enforce the modular **`cms/`** tree (collections, singletons, enums, objects, views, content)
- Add/change collections, singletons, **views/indexes/groups**, processors, schemas, or **integrations**
- Wire folder **i18n** / mix localized and monolingual sources
- Load or list **localized** content the Anhur way (`getX({ locale, … })`, `_meta.locale`) — not custom filters
- Wire Orama search (`orama({…})` in `integrations`, `createSearcher`)
- Wire Vite (`anhur/generated` alias + asset serving) or CI (`anhur build`)
- Wire **remote asset storage** (`assets({ storage })`, files-sdk, CDN `base`, prune)
- Debug processor/schema mismatches, assets, drafts, localization, views, or search index output

## Package map

| Package           | Install when     | Provides                                                                                                                                            |
| ----------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@anhur/core`     | Always           | `defineConfig`, collections/singletons, `defineView`/`defineIndex`/`defineGroup`, `schema as s`, CLI `anhur`, `build`/`watch`, integrations runtime |
| `@anhur/vite`     | Vite apps        | Plugin: Vite-watcher rebuilds, build logs, `anhur/generated` alias, serve `.anhur/assets`                                                           |
| `@anhur/mdx`      | MDX bodies       | `mdx()` processor, `schema as m` → `m.mdx()`, `MDXContent` from `@anhur/mdx/react`                                                                  |
| `@anhur/markdown` | Markdown→HTML    | `markdown()` processor, `schema as md` → `md.markdown()`                                                                                            |
| `@anhur/assets`   | Images/files     | `assets()` processor, `a.image()` / `a.file()`, optional CDN sync via `storage` + files-sdk                                                         |
| `@anhur/orama`    | Full-text search | `orama()` integration + `createSearcher` (browser/server)                                                                                           |

**Rule:** every schema helper from an opt-in package needs its processor in `defineConfig({ processors })`. Missing processor → build fails.

**Integrations** (search, custom post-codegen work) go in `defineConfig({ integrations })`, not `processors`. See [references/search.md](references/search.md).

Details: [references/packages.md](references/packages.md)

## Integration checklist

Copy and track:

```
- [ ] Install packages (core + vite and/or opt-ins)
- [ ] Add thin anhur.config.ts (processors / localization / content / views / integrations only)
- [ ] Scaffold cms/: collections/, singletons/, enums/, objects/, views/, content/, content.ts
- [ ] Register processors matching schema helpers
- [ ] One module per collection / singleton; shared enums/objects extracted
- [ ] Author files under cms/content/ (locale folders when using folder i18n)
- [ ] Export `content` tuple from cms/content.ts; wire views via createDerivedHelpers
- [ ] Optional: views: [defineView / defineIndex / defineGroup]
- [ ] Optional: integrations: [orama({…})]
- [ ] Optional: assets({ storage }) for CDN upload (files-sdk peers, enabled in CI/prod only)
- [ ] Vite: plugins: [anhur()] + tsconfig paths for anhur/generated
- [ ] Include .anhur/generated in tsconfig; gitignore .anhur/cache (optional commit generated)
- [ ] Smoke: anhur build OR vite dev; import from anhur/generated (and search index if used)
```

Project layout (required): [references/project-structure.md](references/project-structure.md)

Full Vite/tsconfig/CLI steps: [references/integration.md](references/integration.md)

## Minimal Vite app

```sh
bun add @anhur/core @anhur/vite
# optional:
bun add @anhur/mdx @anhur/markdown @anhur/assets @anhur/orama
```

`vite.config.ts`:

```ts
import { defineConfig } from "vite";
import anhur from "@anhur/vite";

export default defineConfig({
  plugins: [anhur() /* { configPath: "anhur.config.ts" } */],
});
```

`tsconfig.json` paths (Vite plugin aliases at runtime; TS still needs this):

```json
{
  "include": ["**/*.ts", "**/*.tsx", ".anhur/generated"],
  "compilerOptions": {
    "paths": {
      "anhur/generated": ["./.anhur/generated"]
    }
  }
}
```

## Search (`@anhur/orama`)

Put `orama({…})` in `integrations`. Plain `defineConfig({…})` is enough — no
`defineConfig<typeof content>`. `defineConfig` infers the inline `content` array
and types `index` / `store` (do **not** pass `content` into `orama`).

```ts
import { defineConfig } from "@anhur/core";
import { orama } from "@anhur/orama";

export default defineConfig({
  content: [posts, pages],
  integrations: [
    orama({
      collections: {
        posts: {
          schema: { title: "string", summary: "string" },
          index: (doc) => ({
            title: doc.title,
            summary: doc.summary ?? "",
          }),
          store: (doc) => ({
            title: doc.title,
            slug: doc.slug,
            href: `/posts/${doc.slug}`,
          }),
        },
      },
    }),
  ],
});
```

- Rejects unknown collection keys and singleton names at typecheck
- Writes `.anhur/generated/search/orama.json` (override with `directory` / `filename`)
- App: `import { createSearcher } from "@anhur/orama/client"` then load that JSON (browser or server)

Full options, client usage, custom integrations: [references/search.md](references/search.md)

## Project structure (required)

Do **not** put collections, singletons, enums, objects, or views inline in `anhur.config.ts`. Use a modular tree (default root `cms/`):

```text
anhur.config.ts              # thin wire-up only
cms/
  content.ts                 # `export const content = […] as const`
  collections/               # one defineCollection per file
  singletons/                # one defineSingleton per file
  enums/                     # shared s.enum(…)
  objects/                   # shared s.object(…) fragments
  views/
    helpers.ts               # createDerivedHelpers(content)
    *.ts                     # one defineView / defineIndex / defineGroup each
  content/                   # author MD/MDX/YAML/JSON + assets only
    posts/en/….mdx           # folder i18n when localization is enabled
    authors/….yml            # localized: false → no locale segment
```

Full rules, localization layouts, checklists, anti-patterns: [references/project-structure.md](references/project-structure.md)

## Config shape

Thin config + modular modules (abbreviated):

```ts
// cms/enums/product-status.ts
import { schema as s } from "@anhur/core";
export const productStatus = s.enum(["active", "discontinued"]);

// cms/collections/posts.ts
import { defineCollection, schema as s } from "@anhur/core";
import { schema as a } from "@anhur/assets";
import { schema as m } from "@anhur/mdx";

export const posts = defineCollection({
  name: "posts",
  directory: "cms/content/posts",
  include: "**/*.{md,mdx}",
  generate: { emitIds: true, emitSlugs: true },
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    featured: s.boolean().optional(),
    draft: s.boolean().optional(),
    cover: a.image().optional(),
    body: m.mdx(),
  }),
  transform: (doc, ctx) => {
    if (doc.draft === true) return ctx.skip("draft");
    return doc;
  },
});

// cms/collections/products.ts — monolingual catalog
import { productStatus } from "../enums/product-status";

export const products = defineCollection({
  name: "products",
  directory: "cms/content/products",
  include: "**/*.json",
  localized: false,
  generate: { split: "list-only", listOmit: [] },
  schema: s.object({
    name: s.string(),
    sku: s.unique(),
    category: s.string(),
    status: productStatus.optional(),
    price: s.string(),
  }),
});

// cms/content.ts
export const content = [posts, products] as const;

// cms/views/helpers.ts
import { createDerivedHelpers } from "@anhur/core";
import { content } from "../content";
export const { defineView, defineGroup, defineIndex } = createDerivedHelpers(content);

// cms/views/featured-posts.ts — import defineView from ./helpers, not @anhur/core
import { posts } from "../collections/posts";
import { defineView } from "./helpers";

export const featuredPosts = defineView({
  name: "featuredPosts",
  from: posts,
  where: (doc): doc is typeof doc & { featured: true } => doc.featured === true,
  generate: { limit: 12 },
});

// anhur.config.ts
import { assets } from "@anhur/assets";
import { defineConfig } from "@anhur/core";
import { mdx } from "@anhur/mdx";
import { orama } from "@anhur/orama";
import { content } from "./cms/content";
import { featuredPosts } from "./cms/views/featured-posts";
import { productBySku } from "./cms/views/product-by-sku";
import { productsByCategory } from "./cms/views/products-by-category";

export default defineConfig({
  localization: {
    strategy: "folder",
    locales: ["en", "de"],
    defaultLocale: "en",
  },
  processors: [mdx({ gfm: true }), assets({ dir: ".anhur/assets", base: "/anhur-assets/" })],
  content,
  views: [featuredPosts, productBySku, productsByCategory],
  integrations: [
    orama({
      collections: {
        posts: {
          schema: { title: "string" },
          index: (doc) => ({ title: doc.title }),
          store: (doc) => ({ slug: doc.slug }),
        },
      },
    }),
  ],
});
```

Schema helpers, generate splits, hooks: [references/schemas.md](references/schemas.md)

Views / indexes / groups: [references/views.md](references/views.md)

CDN / object storage for assets: [references/assets-storage.md](references/assets-storage.md)

## Content layout

Author files live under `cms/content/` (or the chosen root’s `content/`).

**Localized** (default when `localization` is set): `{directory}/{locale}/…`  
Example: `cms/content/posts/en/hello.mdx`, `cms/content/posts/de/hello.mdx`.

**Monolingual:** set `localized: false` (files directly under `directory`, or singleton `filePath`).

Mix localized and monolingual sources in one project. `defaultLocale` must be listed in `locales`.

Built-in loaders: front-matter MD/MDX, YAML, JSON. Extra loaders via `loaders` (matched before builtins).

## Localization — consuming data

Folder i18n is already baked into generated exports. **Use those APIs** — do not hand-filter with a custom `lang` field, re-glob `cms/content/`, or invent a second content i18n layer.

When `localization` is set, import the catalog from generated output:

```ts
import { type Locale, locales, defaultLocale } from "anhur/generated";
// Locale = "de" | "en"  •  locales / defaultLocale are runtime consts
```

| Need                     | Do this                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| One document in a locale | `await getPost({ locale, slug })` — `locale: Locale` **required** |
| List for a locale        | `allPosts.filter((p) => p._meta.locale === locale)`               |
| Default-locale singleton | import `settings` (primary export)                                |
| Singleton in any locale  | `await getSettings({ locale })` — `locale` required               |
| Monolingual collection   | `getAuthor("jane")` / `allAuthors` — no locale in the typed API   |
| Shared app locale type   | `import type { Locale } from "anhur/generated"`                   |

**Rules that bite:**

1. `_meta.locale` is typed as `Locale` on localized docs — not a schema field you invent.
2. `allPosts` includes **every** locale. Always scope lists with `_meta.locale` (or a view `where` that checks it).
3. Localized getters require `{ locale: Locale, … }` in `.d.ts`. Bare `getPost("slug")` is runtime-only / discouraged.
4. `defineIndex({ key: "slug" })` fails if the same slug exists in `en` and `de`. Use the getter, or a composite key `` `${doc._meta.locale}:${doc.slug}` ``.
5. References resolve **same locale first** — no custom join for “German author of German post.”

```ts
import { type Locale, allPosts, getPost, getSettings, settings } from "anhur/generated";

const locale: Locale = params.locale;
const post = await getPost({ locale, slug: params.slug });
if (!post) throw notFound();

const posts = allPosts.filter((p) => p._meta.locale === locale);

settings; // defaultLocale only
const localizedSettings = await getSettings({ locale });
```

Full patterns, indexes/views, singletons, anti-patterns: [references/localization.md](references/localization.md)

## Generated API (default `light` split)

When `localization` is set:

- `Locale` — `"en" \| "de"` (sorted union from config)
- `locales` / `defaultLocale` — runtime consts (+ `.d.ts`)

For collection `posts`:

- `allPosts` — light list of **all locales** (default omits `body` when that field exists); `_meta.locale: Locale`
- `getPost({ locale, id?, slug? })` — full document; `locale` **required** when the source is localized
- Optional: `PostId`, `PostSlug` when `generate.emitIds` / `emitSlugs`

For localized singleton `settings`:

- `settings` — **`defaultLocale`** document
- `settingsAll` (default `variantsName`; overridable) — all locale variants when `emitAll`
- `getSettings({ locale })` — `locale: Locale` required

From `views` (list-only — no getters):

| Helper        | Example export                                   |
| ------------- | ------------------------------------------------ |
| `defineView`  | `allFeaturedPosts`                               |
| `defineIndex` | `productBySku` + `ProductBySkuKey` literal union |
| `defineGroup` | `productsByCategory` → `{ key, count, items }[]` |

```ts
import {
  type Locale,
  allPosts,
  getPost,
  productBySku,
  productsByCategory,
  settings,
} from "anhur/generated";

const locale = "en" satisfies Locale;
const post = await getPost({ locale, slug: "hello" });
if (!post) throw notFound(); // or your router’s missing-page helper

const enPosts = allPosts.filter((p) => p._meta.locale === locale);

productBySku["W-100"]?.price;
productsByCategory.find((g) => g.key === "widgets")?.items;
```

Import id is always `anhur/generated` (not a relative path).

Monolingual collections (`localized: false`) keep string id/slug getters (no `locale` in the typed query).

## CLI (no Vite)

```sh
bunx anhur build --root .
bunx anhur watch --root .
# --config path/to/anhur.config.ts
```

## React MDX

```tsx
import { MDXContent } from "@anhur/mdx/react";

export function PostBody({ code }: { code: string }) {
  return <MDXContent code={code} />;
}
```

`code` is the compiled string from `m.mdx()` on the full document (`getPost`).

## Hard rules

1. **Modular layout:** collections, singletons, enums, objects, and views live under `cms/` (or the project’s documented equivalent). `anhur.config.ts` only wires `processors`, optional `localization`, `content`, `views`, and `integrations`. See [references/project-structure.md](references/project-structure.md).
2. **One concern per file:** one `defineCollection` / `defineSingleton` / view / enum / object module. Shared closed sets → `cms/enums/`; reusable objects → `cms/objects/`. Author files only under `cms/content/`.
3. Export a single `content` tuple from `cms/content.ts` (`as const`). Bind views with `createDerivedHelpers(content)` in `cms/views/helpers.ts` and import `defineView` / `defineIndex` / `defineGroup` from there — not from `@anhur/core`.
4. Processor + schema field must match (`m.mdx` ↔ `mdx()`, `a.image` ↔ `assets()`, …).
5. Relative body images/links need `assets()`; without it they fail the build.
6. Prefer `m.mdx()` / `md.markdown()` / `s.raw()` for bodies — not ad-hoc compile in `transform`.
7. Drafts: `draft: true` or `ctx.skip(reason)` in `transform`.
8. Search / post-codegen packages use `integrations: [orama({…})]`, not `processors` or `complete: orama(…)`.
9. Use plain `defineConfig({ content, integrations: [orama({…})] })` — no `defineConfig<typeof content>`, and never pass `content` into `orama`.
10. Put `defineView` / `defineIndex` / `defineGroup` in `views`, never in the `content` tuple. Multi-collection views require `select`. Index keys must be unique or the build fails.
11. Prefer `defineIndex` over filtering a huge `list-only` collection for detail routes. Prefer `generate.compare` over string `listSort` for numeric fields stored as strings.
12. Localization: folder strategy under `{directory}/{locale}/…` when `localization` is set; use `localized: false` per source for monolingual trees. Consume with generated `Locale` / `getX({ locale, … })` / `_meta.locale` — never custom `lang` fields, filesystem re-parse, or bare-slug indexes across locales. See [references/localization.md](references/localization.md).
13. Do not invent a Next adapter, Valibot schemas, or Orama vector/AI search — out of scope. CDN/object upload is supported via `assets({ storage })` + files-sdk (gate with `enabled`, require `prefix`, prefer a `files` factory; empty-emit skips prune unless `pruneEmpty: true`).
14. Package scope `@anhur` may rename before/after publish; keep config names (`anhur.config.ts`, `.anhur/`, `anhur/generated`) unless the project documents a rename.

## Failure modes

See [references/pitfalls.md](references/pitfalls.md).

## Done when

- Layout matches modular `cms/` tree (thin config, `content.ts`, helpers-bound views)
- `anhur build` or Vite `buildStart` succeeds
- App imports from `anhur/generated` typecheck
- Opt-in fields used only with matching processors
- Localized folders match `locales` / `defaultLocale` (or `localized: false` per source)
- App loads locale content via `Locale` + getters + `_meta.locale` (no custom lang filters / content re-parse)
- If search is configured: `.anhur/generated/search/orama.json` exists and `createSearcher` works in app
- If views are configured: derived exports import and typecheck (`allFeatured…`, indexes, groups)
