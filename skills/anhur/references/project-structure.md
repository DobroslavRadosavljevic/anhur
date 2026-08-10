# Project structure (required)

Keep Anhur **schema modules**, **views**, and **author files** out of a monolithic `anhur.config.ts`. Use this layout in every project (rename the root folder only if the repo already has a convention — default name is `cms/`).

```text
anhur.config.ts                 # thin: processors, localization, content, views, integrations
cms/
  content.ts                    # `export const content = […] as const`
  collections/                  # one `defineCollection` per file
  singletons/                   # one `defineSingleton` per file
  enums/                        # shared `s.enum(…)` fragments
  objects/                      # shared `s.object(…)` / field groups
  views/
    helpers.ts                  # `createDerivedHelpers(content)` → defineView/Index/Group
    *.ts                        # one view / index / group per file
  content/                      # author files only (MD/MDX/YAML/JSON + assets)
    posts/
      en/hello.mdx              # localized (folder i18n)
      de/hello.mdx
    authors/
      jane.yml                  # monolingual collection → `localized: false`
    about.mdx                   # monolingual singleton → `filePath`
```

Paths in `directory` / `filePath` are relative to the **config file’s directory** (usually the repo root). Prefer `cms/content/…` so content stays under the same tree as schemas.

## What goes where

| Path | Put here | Do not put here |
| ---- | -------- | --------------- |
| `cms/collections/<name>.ts` | `defineCollection({…})` | Inline enums/objects used by 2+ schemas — extract first |
| `cms/singletons/<name>.ts` | `defineSingleton({…})` | Multi-doc folders (those are collections) |
| `cms/enums/<name>.ts` | Closed string sets: `export const status = s.enum([…])` | Open `s.string()` fields |
| `cms/objects/<name>.ts` | Reusable object shapes (`faqItem`, `geo`, `plan`, …) | Whole collections |
| `cms/views/<name>.ts` | One `defineView` / `defineIndex` / `defineGroup` | Collection definitions |
| `cms/views/helpers.ts` | `createDerivedHelpers(content)` only | Business filters |
| `cms/content.ts` | Ordered `content` tuple (`as const`) of every collection + singleton | Views, processors |
| `cms/content/**` | Front matter + bodies + colocated images | TypeScript schemas |
| `anhur.config.ts` | `defineConfig({ processors, localization?, content, views?, integrations? })` | Large inline schemas |

## Naming

- **Files:** kebab-case (`blog-posts.ts`, `proxy-kind.ts`).
- **Exports:** camelCase matching the Anhur `name` when practical (`blogPosts`, `proxyKind`).
- **Collection `name`:** stable Anhur id (often snake or plural); used by `s.reference("…")` and Orama keys — do not rename lightly.
- **One primary export per module** (plus types if needed). Re-export from `content.ts` / `views/*` only.

## `cms/content.ts`

```ts
import { posts } from "./collections/posts";
import { authors } from "./collections/authors";
import { site } from "./singletons/site";

/**
 * Shared tuple for `defineConfig` and `createDerivedHelpers`.
 * Pass the same array into helpers so embed fields remap in callbacks.
 */
export const content = [authors, posts, site] as const;
```

- Include **every** collection and singleton that participates in the build.
- Order can matter for readability and for docs; keep dependencies (referenced collections) earlier when helpful.
- Views are **not** in this array — they go in `defineConfig({ views })`.

## Views helpers

```ts
// cms/views/helpers.ts
import { createDerivedHelpers } from "@anhur/core";
import { content } from "../content";

export const { defineView, defineGroup, defineIndex } =
  createDerivedHelpers(content);
```

View modules must import `defineView` / `defineIndex` / `defineGroup` from `./helpers`, **not** from `@anhur/core`, so `where` / `select` / `key` see embedded references correctly.

```ts
// cms/views/featured-posts.ts
import { posts } from "../collections/posts";
import { defineView } from "./helpers";

export const featuredPosts = defineView({
  name: "featuredPosts",
  from: posts,
  where: (doc): doc is typeof doc & { featured: true } => doc.featured === true,
});
```

## Thin `anhur.config.ts`

```ts
import { assets } from "@anhur/assets";
import { defineConfig } from "@anhur/core";
import { mdx } from "@anhur/mdx";
import { orama } from "@anhur/orama";

import { content } from "./cms/content";
import { featuredPosts } from "./cms/views/featured-posts";
import { postBySlug } from "./cms/views/post-by-slug";

export default defineConfig({
  localization: {
    strategy: "folder",
    locales: ["en", "de"],
    defaultLocale: "en",
  },
  processors: [
    mdx({ gfm: true }),
    assets({ dir: ".anhur/assets", base: "/anhur-assets/" }),
  ],
  content,
  views: [featuredPosts, postBySlug],
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

## Localization

When `localization` is set on the config:

| Source | Default layout | Opt out |
| ------ | -------------- | ------- |
| Collection | `{directory}/{locale}/**` e.g. `cms/content/posts/en/hello.mdx` | `localized: false` → files directly under `directory` |
| Singleton | `{directory}/{locale}/index.md(x)` | `localized: false` + `filePath: "cms/content/about.mdx"` |

Rules:

1. Every locale folder name must appear in `locales`; `defaultLocale` must be one of them.
2. Mix freely: e.g. localized `posts` + monolingual `authors` (`localized: false`).
3. App getters for folder i18n take `{ locale, id?, slug? }`. Monolingual sources use the internal locale key `default`.
4. Do **not** invent a second i18n system beside Anhur’s folder strategy unless the project already documents one.
5. Consume locale data with generated APIs + `_meta.locale` — see [localization.md](localization.md).

### Localized collection module

```ts
// cms/collections/posts.ts
export const posts = defineCollection({
  name: "posts",
  directory: "cms/content/posts",
  include: "**/*.{md,mdx}",
  // localized defaults to true when config.localization is set
  generate: { emitIds: true, emitSlugs: true },
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    body: m.mdx(),
  }),
});
```

### Monolingual collection module

```ts
export const authors = defineCollection({
  name: "authors",
  directory: "cms/content/authors",
  include: "**/*.{yml,yaml}",
  localized: false,
  schema: s.object({
    name: s.string(),
    slug: s.slug(),
  }),
});
```

## Shared enums & objects

Extract when a shape is used in **more than one** collection/singleton, or when the closed set is domain vocabulary worth naming.

```ts
// cms/enums/status.ts
import { schema as s } from "@anhur/core";
export const status = s.enum(["draft", "published", "archived"]);

// cms/objects/faq-item.ts
import { schema as s } from "@anhur/core";
export const faqItem = s.object({
  question: s.string(),
  answer: s.string(),
});
```

Import into collection schemas; do not redefine the same enum inline in multiple files.

## Adding a new collection (checklist)

1. Add author files under `cms/content/<dir>/` (with locale folders if localized).
2. Add `cms/collections/<name>.ts` with `defineCollection`.
3. Extract new shared enums/objects under `cms/enums/` / `cms/objects/` when needed.
4. Append the collection to `cms/content.ts`.
5. Add views under `cms/views/` if you need filters/indexes/groups; register them in `anhur.config.ts` `views`.
6. Extend `orama({ collections })` only if the collection should be searchable.
7. Run `anhur build` / `bun run content` / Vite so `anhur/generated` updates.

## Adding a singleton

1. Add the file (`cms/content/….mdx` or localized `…/{locale}/index.mdx`).
2. Add `cms/singletons/<name>.ts`.
3. Append to `cms/content.ts`.
4. Rebuild.

## Anti-patterns

- Giant `anhur.config.ts` with inline `defineCollection` / schemas / views
- Defining views with `defineView` from `@anhur/core` while the project uses `createDerivedHelpers`
- Putting TypeScript schema modules under `cms/content/`
- Duplicating the same `s.enum([…])` in multiple collections
- Relative imports from the app into `.anhur/` (always `anhur/generated`)
- Hand-editing `.anhur/generated`
