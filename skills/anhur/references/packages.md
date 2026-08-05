# Packages

## `@anhur/core`

Always required.

Exports (typical):

- `defineConfig`, `defineCollection`, `defineSingleton`
- `schema as s` — Zod plus `raw`, `unique`, `slug`, `reference`, `isodate`, `excerpt`, `metadata`, `toc`
- `getDocumentMeta()` — ALS meta inside schema `.transform` / field resolvers
- `build` / `watch` (programmatic) and CLI bin `anhur`
- `formatAnhurError`

Config highlights:

| Field          | Role                                                                                 |
| -------------- | ------------------------------------------------------------------------------------ |
| `content`      | Collections + singletons                                                             |
| `localization` | `{ strategy: "folder", locales, defaultLocale }`                                     |
| `outputDir`    | Default `.anhur/generated` (relative to config file)                              |
| `cacheDir`     | Default `.anhur/cache`; `false` disables. Skipped when `assets()` rewrites bodies |
| `loaders`      | Extra loaders before matter/yaml/json                                                |
| `processors`   | `mdx()`, `markdown()`, `assets()`, …                                                 |
| `prepare`      | After transforms/filters, before codegen                                             |
| `complete`     | After codegen + per-source `onSuccess`                                               |

Engines: Node `^22.18.0` or `>=24.11.0`.

## `@anhur/vite`

Default export: `anhur(options?: { configPath?: string })`.

Does:

1. Resolve `anhur.config.ts` from Vite root (or `configPath`)
2. Alias `anhur/generated` → `.anhur/generated`
3. `optimizeDeps.exclude` that id
4. Build on `buildStart`; watch + HMR in `configureServer`
5. Middleware for `assets().base` (default `/anhur-assets/`) from `.anhur/assets`

Production: plugin copies assets into Vite `publicDir` as needed so static hosts serve them.

## `@anhur/mdx`

```ts
import { mdx, schema as m } from "@anhur/mdx";
import { MDXContent } from "@anhur/mdx/react";
```

- `processors: [mdx({ gfm?: boolean, … })]`
- Schema field: `body: m.mdx()`
- React: `<MDXContent code={doc.body} />` (compiled string)

## `@anhur/markdown`

```ts
import { markdown, schema as md } from "@anhur/markdown";
```

- `processors: [markdown({ gfm?: boolean })]`
- Schema field: `body: md.markdown()` → HTML string

## `@anhur/assets`

```ts
import { assets, schema as a } from "@anhur/assets";
```

- `processors: [assets({ dir?: string, base?: string })]`
  - Defaults: `dir: ".anhur/assets"`, `base: "/anhur-assets/"`
- Schema: `cover: a.image()`, `brochure: a.file()` (optional variants)
- Rewrites relative URLs in MDX/Markdown **bodies** when those processors run
- Peer/native: `sharp` — trust lifecycle scripts under Bun if install blocks them (`bun pm untrusted`)

## Dependency order (mental model)

```
core
 ├─ assets
 ├─ markdown
 ├─ mdx (often with assets for body images)
 └─ vite (depends on core; drives build in Vite apps)
```

Install only what the config uses. Empty `processors` is fine for YAML/JSON-only schemas using core `s.*` fields.
