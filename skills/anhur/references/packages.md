# Packages

Node `^22.18.0` or `>=24.11.0`. `zod` `^4.1` is a peer of every package except `@anhur/vite`.

## `@anhur/core`

Always required. Three entries:

**`@anhur/core`** (config DSL)

- `defineConfig`, `defineCollection`, `defineSingleton`
- `defineView`, `defineIndex`, `defineGroup`, `createDerivedHelpers(content)`
- `schema as s` — Zod plus `raw`, `unique`, `slug`, `reference`, `isodate`, `excerpt`, `metadata`, `toc`
- `createSkippedSignal`, `isSkippedSignal`
- Types: `GetTypeByName`, `GetViewByName`, `InferDocument`, `RemapEmbeddedRefs`, `TypedConfig`, `Diagnostic`, …
- `AnhurBuildError`, `isAnhurBuildError`, `formatDiagnostics`

**`@anhur/core/build`** (engine, for hosts and scripts)

- `build(options)`, `check(options)`, `watch(options, { onBuild, onError })`, `createAnhur(options)` (reusable session)
- `BuildResult`: `documentCount`, `written`, `removed`, `warnings`, `timings` (per stage), `reuse` (`{ unchanged, compared, validated }` documents), `notStored` (sources validated in every session, with the reason). `AnhurBuildError`: `diagnostics`, `timings`
- `isRelevantChange(file, watchTargets)`, `MANIFEST_FILE`, `CONFIG_FILE_NAMES`
- Options: `rootDir`, `configPath`, `mode` (`build` | `dev`), `publicPathPrefix`, `dryRun`

**`@anhur/core/plugin`** (authoring)

- `definePlugin`, `defineContentPlugin`, `defineLoader`
- `defineField(zodSchema, { kind, whenAbsent, compile, requires?, cache?, pure?, shares? })` — custom compile-time fields with an explicit `FieldContext` (document, body, `emitAsset`, `addDependency`, `getPlugin`, `share`, `isShared`)
  - `whenAbsent` is required: `"skip"` (leave a missing key to Zod) or `"compile"` (fields made from the body).
  - Set `pure: true` when the value depends only on the input, the body, the document and what the field reports through its context; with options, `pure: { key: fingerprint(options) }`. Or set `cache: { version, key }` for costly values. A field with neither turns the on-disk document store off for its whole collection (`result.notStored` says so).
  - A loader in `defineConfig({ loaders })` sets `pure: true` when its result depends only on the file text.
- `rehypeLinkedAssets`, `classifyUrl`, `parseSrcset`, `fingerprint`, `buildToc`, text helpers

**CLI** `anhur build | check | watch` with `--root`, `--config`, `--json`, `--timings`.

Config fields:

| Field          | Role                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------- |
| `content`      | Collections + singletons                                                                     |
| `views`        | `defineView` / `defineIndex` / `defineGroup`                                                 |
| `localization` | `{ strategy: "folder", locales, defaultLocale }`                                             |
| `plugins`      | `mdx()`, `markdown()`, `assets()`, `orama()`, `definePlugin(…)`                              |
| `loaders`      | Extra file loaders (tried before plugin loaders and built-ins)                               |
| `outputDir`    | Default `.anhur/generated` (relative to the config file)                                     |
| `cacheDir`     | Disk caches (validated documents, compiled fields), default `.anhur/cache`; `false` disables |
| `workers`      | Worker threads for compiling many documents: `true` (default: measured, 2 to 6), a number, or `false` |
| `prepare`      | After transforms and drafts; before references, uniqueness, views                            |
| `complete`     | After the output is written, with `{ projectDir, outputDir }`                                |

Views detail: [views.md](views.md)

## `@anhur/vite`

`anhur(options?: { configPath?: string })` (default export too).

1. Creates a build session when Vite resolves its config (`dev` or `build` mode, Vite `base` as public path prefix)
2. Resolves `anhur/generated` to the generated `index.js`; excludes it from dependency optimization
3. `vite build`: builds in `buildStart` (fails the build with diagnostics); `--watch` adds watch files
4. `vite dev`: builds on startup, rebuilds on relevant watcher events (debounced, serialized); errors go to the overlay and terminal without stopping the server; recovers with a reload
5. Serves copied assets (Range, ETag, content types; no dotfiles or traversal)
6. Copies local assets into the client build output

## `@anhur/mdx`

- `mdx(options?)` plugin; `schema as m` → `m.body()` (document body) and `m.mdx()` (string field)
- Output: a function-body string; render with `MdxContent` / `useMdxComponent` / `getMdxComponent` from `@anhur/mdx/react`
- `import`, re-exports, dynamic `import()` and top-level `await` in MDX fail the build; options that do nothing with function-body output (`jsxImportSource`, `jsx*`, `pragma*`, `development`, `outputFormat`, `baseUrl`, `providerImportSource`) are rejected
- `.md` files compile with MDX's Markdown format (raw HTML kept, not sanitized); `m.mdx()` fields are always MDX
- MDX is code; evaluation uses `new Function` (CSP needs `'unsafe-eval'` where MDX renders in the browser; edge runtimes cannot render it)

## `@anhur/markdown`

- `markdown(options?)` plugin; `schema as md` → `md.body()` and `md.markdown()`
- HTML is sanitized with `DEFAULT_SANITIZE_SCHEMA` (GitHub's schema plus media and responsive images) unless `allowDangerousHtml: true`; files are resolved only for elements that survive sanitizing; GFM footnotes and in-page anchors work; heading ids match `s.toc()`
- Options: `gfm`, `headingIds`, `sanitizeSchema`, `allowDangerousHtml`, `remarkPlugins`, `rehypePlugins` (run after sanitizing — unsanitized), `documentLink` (`{ url, path, suffix, target, document }`)

## `@anhur/assets`

- `assets(options?)` plugin; `schema as a` → `a.image({ allowRemote?, blur? })`, `a.file()`
- Relative body URLs (Markdown/MDX images, media, `srcset`, JSX attributes) copied and rewritten
- Options: `dir`, `base`, `devBase`, `roots`, `extensions`, `svg`, `storage`
- Exports `DEFAULT_ASSET_EXTENSIONS` (images, audio, video, `.vtt`, fonts, `.pdf`) and `DOCUMENT_ASSET_EXTENSIONS` (opt-in: `.json`, `.txt`, `.csv`, archives, office files), plus `pruneAssets` / `pruneStorage`
- SVGs are parsed and rebuilt from an allowlist (`svg: "sanitize"`, default)
- `sharp` (optional peer) for image metadata; `files-sdk` (optional peer) for storage

Storage: [assets-storage.md](assets-storage.md)

## `@anhur/orama`

- `orama({ collections, languages?, path? })` plugin; `languages` adds stemming for 28 languages (`@orama/stemmers`, loaded lazily per language)
- Generates `loadSearchIndex(locale)` / `searchLocales` and the types `AnhurSearchStores` (hit stores typed from `store()`) / `AnhurSearchField` in `anhur/generated`
- `createSearcher(index)` from `@anhur/orama/client`

Search: [search.md](search.md)
