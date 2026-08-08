# Packages

## `@anhur/core`

Always required.

Exports (typical):

- `defineConfig`, `defineCollection`, `defineSingleton`
- `defineView`, `defineIndex`, `defineGroup` — build-time derived lists / maps / groups
- `schema as s` — Zod plus `raw`, `unique`, `slug`, `reference`, `isodate`, `excerpt`, `metadata`, `toc`
- `getDocumentMeta()` — ALS meta inside schema `.transform` / field resolvers
- `GetViewByName`, `DerivedName`, `InferViewData` — view typing helpers
- `build` / `watch` (programmatic) and CLI bin `anhur`
- `formatAnhurError`
- Integrations: `defineIntegration`, `registerIntegration`, `createIntegrationConfigEntry`, `IntegrationConfigEntry`, …

Config highlights:

| Field          | Role                                                                              |
| -------------- | --------------------------------------------------------------------------------- |
| `content`      | Collections + singletons                                                          |
| `views`        | `defineView` / `defineIndex` / `defineGroup` (after prepare, before codegen)      |
| `localization` | `{ strategy: "folder", locales, defaultLocale }`                                  |
| `outputDir`    | Default `.anhur/generated` (relative to config file)                              |
| `cacheDir`     | Default `.anhur/cache`; `false` disables. Skipped when `assets()` rewrites bodies |
| `loaders`      | Extra loaders before matter/yaml/json                                             |
| `processors`   | `mdx()`, `markdown()`, `assets()`, …                                              |
| `integrations` | `orama({…})`, `defineIntegration({…})`, … — after codegen, before `complete`      |
| `prepare`      | After transforms/filters, before views + codegen                                  |
| `complete`     | After codegen + per-source `onSuccess` + integrations                             |

Views detail: [views.md](views.md)

Engines: Node `^22.18.0` or `>=24.11.0`.

## `@anhur/vite`

Default export: `anhur(options?: { configPath?: string })`.

Does:

1. Resolve `anhur.config.ts` from Vite root (or `configPath`)
2. Alias `anhur/generated` → `.anhur/generated`
3. `optimizeDeps.exclude` that id
4. Build on `buildStart` / `configureServer`; in dev, use Vite’s file watcher on config + content roots, then invalidate `anhur/generated` and full-reload
5. Log document counts (and per-source ids) on startup and each rebuild
6. Middleware for `assets().base` (default `/anhur-assets/`) from `.anhur/assets`

Production: plugin copies assets into the Vite build output so static hosts serve them. When `assets({ storage: { enabled: true } })` uses an absolute `http(s)` CDN `base`, that local outDir copy is skipped (CDN is the source of truth).

Build logs include an `assets storage: N uploaded, …` line when remote sync ran, plus truncated key lists for uploaded / skipped / deleted.

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

- `processors: [assets({ dir?: string, base?: string, storage?: … })]`
  - Defaults: `dir: ".anhur/assets"`, `base: "/anhur-assets/"`
- Schema: `cover: a.image()`, `brochure: a.file()` (optional variants)
- SVG works with both helpers; the original `.svg` is copied as-is. `a.image()` fills size/blur when sharp can rasterize; otherwise size may come from SVG markup and blur stays empty
- Rewrites relative URLs in MDX/Markdown **bodies** when those processors run
- Peer/native: `sharp` — trust lifecycle scripts under Bun if install blocks them (`bun pm untrusted`)
- **Optional CDN sync:** `storage: { enabled, files, prefix, prune?, … }` via [files-sdk](https://files-sdk.dev/) (optional peer). See [assets-storage.md](assets-storage.md).

## `@anhur/orama`

```ts
import { orama } from "@anhur/orama";
import { createSearcher } from "@anhur/orama/client";
```

- `integrations: [orama({ collections: { … } })]` — not a processor
- Types `index` / `store` from the inline `defineConfig({ content })` array
- Writes `{outputDir}/search/orama.json` by default
- Query with `createSearcher(snapshot)` in browser or Node

Full guide: [search.md](search.md)

## Dependency order (mental model)

```
core
 ├─ assets
 ├─ markdown
 ├─ mdx (often with assets for body images)
 ├─ orama (integrations; build-time index + client)
 └─ vite (depends on core; drives build in Vite apps)
```

Install only what the config uses. Empty `processors` / `integrations` is fine for YAML/JSON-only schemas using core `s.*` fields.
