---
name: anhur
description: >-
  Build, review, debug, configure, migrate, teach, or plan Anhur typed content
  (@anhur/core, @anhur/vite, @anhur/mdx, @anhur/markdown,
  @anhur/assets). Use when integrating Anhur into an app, writing or
  changing anhur.config.ts, collections, singletons, processors, Zod content
  schemas, folder i18n, anhur/generated imports, the Vite plugin, CLI
  build/watch, drafts/hooks, MDX/Markdown bodies, or assets — or when the user
  mentions Anhur, .anhur, or local MD/MDX/YAML/JSON content pipelines.
license: MIT
metadata:
  version: "0.0.1"
  packages: "@anhur/core,@anhur/vite,@anhur/mdx,@anhur/markdown,@anhur/assets"
---

# Anhur

## What it is

Anhur turns **files in your repo** (Markdown, MDX, YAML, JSON) into **typed data your app can import**, like `allPosts` and `getPost("hello")`.

At build time it:

1. Reads content from folders you configure
2. Validates each document with **Zod** schemas you write
3. Optionally compiles MDX/Markdown, copies images, resolves relations
4. Writes modules under `.anhur/generated`
5. Lets the app import them as `anhur/generated`

Vite plugs this into `vite dev` / `vite build` via `@anhur/vite`. The `anhur` CLI does the same without Vite. Optional folder-based **i18n** (`content/posts/en/…`, `de/…`). Local content as typed code — not a hosted CMS.

More framing: [references/why.md](references/why.md)

## Why you need it

Without something like Anhur, teams usually:

- Hand-parse Markdown in routes (no shared schema, easy to drift)
- Keep content in a CMS (network, auth, preview complexity) when files in git would do
- Copy-paste front matter shapes across pages with no compile-time checks
- Bolt on i18n later as a second system

Anhur is for when content **lives in the repo**, authors edit files, and the app should treat that content as **typed, validated modules** — lists, getters, relations, drafts, assets — with one config file.

## What it is for

| Use                        | Example                                             |
| -------------------------- | --------------------------------------------------- |
| Blogs / docs / changelogs  | MDX posts, Markdown pages, YAML authors             |
| Marketing / product sites  | Localized pages + site settings singleton           |
| Catalogs / structured data | JSON products with unique SKUs and file attachments |
| Multi-locale sites         | Same collection under `en/` / `de/` folders         |

**Not for (today):** remote CMS as the source of truth, Next-only adapters, CDN asset upload, non-Zod schema libraries.

## When to use this skill

- Explain Anhur to a user or choose it vs CMS / hand loaders
- Greenfield or migrate a site/app onto Anhur content
- Add/change collections, singletons, processors, or schemas
- Wire Vite (`anhur/generated` alias + asset serving) or CI (`anhur build`)
- Debug processor/schema mismatches, assets, drafts, or localization layout

## Package map

| Package           | Install when  | Provides                                                                            |
| ----------------- | ------------- | ----------------------------------------------------------------------------------- |
| `@anhur/core`     | Always        | `defineConfig`, collections/singletons, `schema as s`, CLI `anhur`, `build`/`watch` |
| `@anhur/vite`     | Vite apps     | Plugin: build/watch, `anhur/generated` alias, serve `.anhur/assets`                 |
| `@anhur/mdx`      | MDX bodies    | `mdx()` processor, `schema as m` → `m.mdx()`, `MDXContent` from `@anhur/mdx/react`  |
| `@anhur/markdown` | Markdown→HTML | `markdown()` processor, `schema as md` → `md.markdown()`                            |
| `@anhur/assets`   | Images/files  | `assets()` processor, `schema as a` → `a.image()` / `a.file()` (sharp)              |

**Rule:** every schema helper from an opt-in package needs its processor in `defineConfig({ processors })`. Missing processor → build fails.

Details: [references/packages.md](references/packages.md)

## Integration checklist

Copy and track:

```
- [ ] Install packages (core + vite and/or opt-ins)
- [ ] Add anhur.config.ts next to content (or set configPath)
- [ ] Register processors matching schema helpers
- [ ] Define collections / singletons + content files
- [ ] Vite: plugins: [anhur()] + tsconfig paths for anhur/generated
- [ ] Include .anhur/generated in tsconfig; gitignore .anhur/cache (optional commit generated)
- [ ] Smoke: anhur build OR vite dev; import from anhur/generated
```

Full Vite/tsconfig/CLI steps: [references/integration.md](references/integration.md)

## Minimal Vite app

```sh
bun add @anhur/core @anhur/vite
# optional:
bun add @anhur/mdx @anhur/markdown @anhur/assets
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

## Config shape

```ts
import { defineCollection, defineConfig, defineSingleton, schema as s } from "@anhur/core";
import { assets, schema as a } from "@anhur/assets";
import { markdown, schema as md } from "@anhur/markdown";
import { mdx, schema as m } from "@anhur/mdx";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.{md,mdx}",
  generate: { emitIds: true, emitSlugs: true },
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    draft: s.boolean().optional(),
    cover: a.image().optional(),
    body: m.mdx(),
  }),
  transform: (doc, ctx) => {
    if (doc.draft === true) return ctx.skip("draft");
    return doc;
  },
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
    assets({ dir: ".anhur/assets", base: "/anhur-assets/" }),
  ],
  content: [posts],
});
```

Schema helpers, generate splits, hooks: [references/schemas.md](references/schemas.md)

## Content layout

**Localized** (default when `localization` is set): `{directory}/{locale}/…`

**Monolingual:** set `localized: false` (files directly under `directory`, or singleton `filePath`).

Built-in loaders: front-matter MD/MDX, YAML, JSON. Extra loaders via `loaders` (matched before builtins).

## Generated API (default `light` split)

For collection `posts`:

- `allPosts` — light list (default omits `body` when that field exists)
- `getPost(idOrSlug)` or `getPost({ locale?, id?, slug? })` — full document, or `null` if missing
- Optional: `PostId`, `PostSlug` when `generate.emitIds` / `emitSlugs`

```ts
import { allPosts, getPost, settings } from "anhur/generated";

const post = await getPost("hello");
if (!post) throw notFound(); // or your router’s missing-page helper
```

Import id is always `anhur/generated` (not a relative path).

Monolingual collections (`localized: false`) look up under the internal locale key `default`. Pass `{ locale: "en", … }` when using folder i18n.

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

1. Processor + schema field must match (`m.mdx` ↔ `mdx()`, `a.image` ↔ `assets()`, …).
2. Relative body images/links need `assets()`; without it they fail the build.
3. Prefer `m.mdx()` / `md.markdown()` / `s.raw()` for bodies — not ad-hoc compile in `transform`.
4. Drafts: `draft: true` or `ctx.skip(reason)` in `transform`.
5. Do not invent CDN upload, Next adapter, or Valibot — out of scope.
6. Package scope `@anhur` may rename before/after publish; keep config names (`anhur.config.ts`, `.anhur/`, `anhur/generated`) unless the project documents a rename.

## Failure modes

See [references/pitfalls.md](references/pitfalls.md).

## Done when

- `anhur build` or Vite `buildStart` succeeds
- App imports from `anhur/generated` typecheck
- Opt-in fields used only with matching processors
- Localized folders match `locales` / `defaultLocale` (or `localized: false`)
