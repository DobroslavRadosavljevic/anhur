---
name: anhur
description: >-
  Build, review, debug, configure, migrate, teach, or plan Anhur typed content
  (@anhur/core, @anhur/vite, @anhur/mdx, @anhur/markdown, @anhur/assets,
  @anhur/orama). Use when integrating Anhur into an app, writing or changing
  anhur.config.ts, the cms/ module tree (collections, singletons, enums,
  objects, views, content.ts, content files), views (defineView / defineIndex /
  defineGroup / createDerivedHelpers), plugins (markdown / mdx / assets / orama
  / definePlugin), custom fields (defineField), Zod content schemas, folder
  i18n / localization, anhur/generated imports, localized getters/lists
  (_meta.locale), the Vite plugin, CLI build/check/watch, drafts/hooks,
  diagnostics, MDX/Markdown bodies, assets, CDN/object storage upload (assets
  storage + files-sdk), or full-text search — or when the user mentions Anhur,
  .anhur, cms/, folder i18n, or local MD/MDX/YAML/JSON content pipelines.
license: MIT
metadata:
  version: "0.0.14"
  packages: "@anhur/core,@anhur/vite,@anhur/mdx,@anhur/markdown,@anhur/assets,@anhur/orama"
---

# Anhur

## What it is

Anhur turns **files in the repo** (Markdown, MDX, YAML, JSON) into **typed data the app imports**, like `allPosts` and `getPost("hello")`.

At build time it:

1. Finds files in the folders you configure and parses them (front matter is YAML)
2. Compiles content fields (Markdown, MDX, images, slugs, …), then validates each document with **Zod**
3. Runs `transform`, drops drafts / skipped documents, runs `prepare`, then checks and embeds references and checks uniqueness
4. Derives views, runs plugin `generate` (e.g. the Orama index)
5. Writes changed modules to `.anhur/generated` (atomically, only files it owns)
6. The app imports them as `anhur/generated`

A build either fully succeeds or writes nothing: every problem is a diagnostic with file, field path and hint.

`@anhur/vite` runs this inside `vite dev` / `vite build`. The `anhur` CLI does the same without Vite. Optional folder **i18n** (`content/posts/en/…`, `de/…`). Local content as typed code — not a hosted CMS.

More framing: [references/why.md](references/why.md)

## What it is for

| Use                        | Example                                                 |
| -------------------------- | ------------------------------------------------------- |
| Blogs / docs / changelogs  | MDX posts, Markdown pages, YAML authors                 |
| Marketing / product sites  | Localized pages + site settings singleton               |
| Catalogs / structured data | JSON products with unique SKUs and file attachments     |
| Directories / SEO facets   | `defineView` / `defineIndex` / `defineGroup` at build   |
| Multi-locale sites         | Same collection under `en/` / `de/` folders             |
| In-app full-text search    | Orama index per locale, any script                      |
| CDN-delivered assets       | Build-time upload via `assets({ storage })` + files-sdk |

**Not for (today):** remote CMS as the source of truth, runtime media uploads, non-Zod schema libraries, vector / AI search, MDX from untrusted authors (MDX is code).

## When to use this skill

- Explain Anhur, or choose it vs a CMS / hand-written loaders
- Greenfield or migrate an app onto Anhur content
- Scaffold or follow the modular **`cms/`** tree
- Add or change collections, singletons, views, schemas, plugins, custom fields
- Wire folder **i18n** and consume localized content the Anhur way (`getX({ locale, … })`, `_meta.locale`)
- Wire search (`orama({…})` in `plugins`, `loadSearchIndex` + `createSearcher`)
- Wire Vite (`plugins: [anhur()]` + tsconfig `paths`) or CI (`anhur check` / `anhur build`)
- Wire **remote asset storage** (`assets({ storage })`, files-sdk, CDN `base`)
- Debug diagnostics: schema errors, references, duplicates, assets, drafts, locales, views, search

## Package map

| Package           | Install when     | Provides                                                                                                              |
| ----------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@anhur/core`     | Always           | `defineConfig`, collections/singletons, views, `schema as s`, CLI; `@anhur/core/build` (engine), `@anhur/core/plugin` |
| `@anhur/vite`     | Vite apps        | `anhur()` plugin: builds, resolves `anhur/generated`, rebuilds, error overlay, serves assets                          |
| `@anhur/mdx`      | MDX bodies       | `mdx()` plugin, `schema as m` → `m.body()` / `m.mdx()`, `MdxContent` from `@anhur/mdx/react`                          |
| `@anhur/markdown` | Markdown → HTML  | `markdown()` plugin, `schema as md` → `md.body()` / `md.markdown()` (sanitized)                                       |
| `@anhur/assets`   | Images/files     | `assets()` plugin, `a.image()` / `a.file()`, optional CDN sync via `storage` + files-sdk                              |
| `@anhur/orama`    | Full-text search | `orama()` plugin, `createSearcher` from `@anhur/orama/client`                                                         |

**Rule:** every field from an opt-in package needs its plugin in `defineConfig({ plugins: [...] })` — missing plugin → build error naming it. There are no separate `processors` / `integrations` lists.

Details: [references/packages.md](references/packages.md)

## Integration checklist

```
- [ ] Install packages (core + zod + vite and/or opt-ins)
- [ ] Thin anhur.config.ts: localization?, content, views?, plugins
- [ ] Recommended: cms/ tree (collections/, singletons/, enums/, objects/, views/, content/, content.ts)
- [ ] Register plugins matching schema fields (mdx(), markdown(), assets(), orama())
- [ ] Author files (locale folders when using folder i18n); draft: true for unpublished
- [ ] Views via createDerivedHelpers(content), registered in views: [...]
- [ ] Vite: plugins: [anhur()]; tsconfig paths { "anhur/generated": ["./.anhur/generated"] }
- [ ] .gitignore .anhur/
- [ ] CI: anhur check (or a build) before tsc
- [ ] Smoke: vite dev or anhur build; import from anhur/generated
```

Layout: [references/project-structure.md](references/project-structure.md) · Vite/tsconfig/CLI: [references/integration.md](references/integration.md)

## Minimal Vite app

```sh
bun add @anhur/core @anhur/vite zod
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import anhur from "@anhur/vite";

export default defineConfig({ plugins: [anhur()] });
```

```jsonc
// tsconfig.json — the plugin resolves the import at runtime; TypeScript needs paths
{
  "include": ["**/*.ts", "**/*.tsx", ".anhur/generated"],
  "compilerOptions": { "paths": { "anhur/generated": ["./.anhur/generated"] } },
}
```

## Config shape

```ts
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
    publishedAt: s.isodate(),
    featured: s.boolean().optional(),
    draft: s.boolean().optional(), // draft: true → dropped from output (still validated)
    author: s.reference("authors", { embed: true }),
    cover: a.image().optional(),
    toc: s.toc(),
    body: m.body(),
  }),
  transform: (doc, ctx) => {
    if (doc.publishedAt > "2100") return ctx.skip("scheduled");
    return { ...doc, url: `/${doc._meta.locale}/posts/${doc.slug}` };
  },
});

// cms/content.ts
export const content = [authors, posts, products, settings] as const;

// cms/views/derived.ts
import { createDerivedHelpers } from "@anhur/core";
import { content } from "../content";
export const { defineView, defineIndex, defineGroup } = createDerivedHelpers(content);

// anhur.config.ts
import { defineConfig } from "@anhur/core";
import { assets } from "@anhur/assets";
import { mdx } from "@anhur/mdx";
import { orama } from "@anhur/orama";
import { content } from "./cms/content";
import { featuredPosts } from "./cms/views/featured-posts";

export default defineConfig({
  localization: { strategy: "folder", locales: ["en", "de"], defaultLocale: "en" },
  content,
  views: [featuredPosts],
  plugins: [
    mdx(),
    assets(),
    orama({
      collections: {
        posts: {
          schema: { title: "string" },
          index: (doc) => ({ title: doc.title }),
          store: (doc) => ({ title: doc.title, href: doc.url }),
        },
      },
    }),
  ],
});
```

`doc` in `orama` / view callbacks is typed from `content` (transform fields and embeds included) — no generics, never pass `content` into `orama`.

Schema fields, generate options, hooks: [references/schemas.md](references/schemas.md) · Views: [references/views.md](references/views.md) · Search: [references/search.md](references/search.md) · Storage: [references/assets-storage.md](references/assets-storage.md)

## Content layout

- **Localized** (default when `localization` is set): `{directory}/{locale}/…` → `cms/content/posts/en/hello.mdx`. Document id = path under the locale folder without extension (`hello`, `guides/intro`).
- **Monolingual:** `localized: false` → files directly under `directory`, or a singleton `filePath`.
- **Localized singleton:** one file per locale folder (`settings/en/index.yml`).
- Hidden files are skipped. Two files with the same id (`a.md` + `a.mdx`, or ids differing only by case) are an error.
- Built-in loaders: Markdown/MDX with YAML front matter, YAML, JSON. Extra loaders via `loaders` or a plugin.

## Localization — consuming data

Use the generated APIs. Do not hand-filter with a custom `lang` field or re-read `cms/content/`.

```ts
import { type Locale, allPosts, getPost, getSettings, locales, settings } from "anhur/generated";

const locale: Locale = params.locale;
const post = await getPost({ locale, slug: params.slug }); // locale required for localized sources
if (!post) throw notFound();

const posts = allPosts.filter((p) => p._meta.locale === locale); // lists contain every locale
settings; // default-locale document
await getSettings({ locale });
```

**Rules that bite:**

1. `allPosts` includes **every** locale — always scope with `_meta.locale`.
2. Localized getters require `{ locale, … }`; monolingual ones take `getAuthor("jane")`.
3. `defineIndex({ key: "slug" })` fails when a slug exists in several locales — use a getter or `` key: (doc) => `${doc._meta.locale}:${doc.slug}` ``.
4. References resolve **in the referrer's locale** (no fallback). Monolingual targets are found from any locale. A reference to a draft / skipped document fails.

Full patterns: [references/localization.md](references/localization.md)

## Generated API (default `light` split)

For collection `posts` (type `Post`):

- `allPosts` — light list (omits `generate.listOmit`, default `["body"]`, also inside embeds)
- `getPost(idOrQuery)` — async, lazy per-document module, `null` when missing
- `Post`, `Posts`, `PostListItem`; `PostId` / `PostSlug` with `emitIds` / `emitSlugs`

Singleton `settings`: `settings`, `getSettings({ locale? })`, `settingsAll` (all variants). With localization: `Locale`, `locales`, `defaultLocale`.

Views (lists only): `defineView` → `allFeaturedPosts`; `defineIndex` → `productBySku` + `ProductBySkuKey`; `defineGroup` → `productsByCategory: { key, count, items }[]`. Plugins add modules (Orama: `loadSearchIndex`, `searchLocales`).

Import id is always `anhur/generated`.

## CLI and programmatic use

```sh
anhur build                 # validate + write
anhur check                 # validate only (CI); exit 1 on errors
anhur watch                 # rebuild on change; failed builds keep the last output
anhur build --root site --config content/anhur.config.ts --json
```

```ts
import { build, check, watch, createAnhur, isAnhurBuildError } from "@anhur/core/build";
```

`AnhurBuildError.diagnostics[]`: `{ severity, code, message, file?, fieldPath?, source?, hint? }`.

## Rendering bodies

```tsx
import { MdxContent } from "@anhur/mdx/react";
<MdxContent code={post.body} components={{ Callout }} />;
```

```tsx
<article dangerouslySetInnerHTML={{ __html: page.body }} /> // md.body(): sanitized HTML
```

MDX evaluates with `new Function` → needs `'unsafe-eval'` under a CSP, or render on the server only; edge runtimes (Cloudflare Workers, Vercel Edge) cannot render it. `import`, dynamic `import()` and top-level `await` in MDX fail the build; pass components instead.

## Hard rules

1. All build extensions go in `plugins: [...]` (`mdx()`, `markdown()`, `assets()`, `orama()`, `definePlugin({...})`). Field ↔ plugin must match.
2. Bodies use `m.body()` / `md.body()` / `s.raw()`; string fields use `m.mdx()` / `md.markdown()`. Never compile Markdown in `transform`.
3. Relative asset URLs need `assets()`; files must be inside the project (or `roots`), not dotfiles, with an allowed extension. Links to other content files are not assets (map them with `documentLink`).
4. Drafts: `draft: true` in the data, or `return ctx.skip(reason)` from `transform`. `prepare` may also remove documents.
5. Views go in `views`, never in `content`. Multi-collection views need `select`. Index keys must be unique.
6. Use `createDerivedHelpers(content)` for views that read embeds or transform fields.
7. Folder i18n only; consume via `Locale`, getters with `locale`, `_meta.locale`.
8. Cross-document data in `transform` comes from `ctx.documents(source)` (validated, pre-transform, read-only). Reading other files directly is not tracked for rebuilds.
9. Remote storage: `base` must be the public URL of `storage.prefix`; uploads run in build mode only; `prune` is opt-in.
10. Out of scope: Next-specific adapters, Valibot, vector search, untrusted MDX.

## Recommended project layout

The `cms/` tree is this skill's convention for keeping config reviewable — Anhur itself only needs paths in `directory` / `filePath`. Follow an existing project convention if there is one. Details and anti-patterns: [references/project-structure.md](references/project-structure.md)

## Failure modes

[references/pitfalls.md](references/pitfalls.md)

## Done when

- `anhur check` / `anhur build` or `vite build` succeeds with no errors
- App imports from `anhur/generated` typecheck
- Opt-in fields have their plugins
- Locale folders match `locales` (or `localized: false`); the app reads locales via generated APIs
- Search (if used): `loadSearchIndex(locale)` + `createSearcher` returns hits in the app
- Views (if used): derived exports import and typecheck
