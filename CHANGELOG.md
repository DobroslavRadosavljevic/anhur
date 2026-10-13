# Changelog

All `@anhur/*` packages are released together with the same version.

## Unreleased

A rework of the build engine for sites with thousands of files. A build now does work only for what changed. Measured with the benchmark in [`apps/bench`](apps/bench) on generated projects (MDX posts, Markdown pages, JSON products, one image per four documents, views, search), with Bun on an Apple M3 Max:

| Scenario                              | 1,000 documents   | 5,000 documents  |
| ------------------------------------- | ----------------- | ---------------- |
| First build, no caches                | 7.96 s → 2.52 s   | 38.3 s → 11.7 s  |
| Rebuild in a session, nothing changed | 186 ms → 11 ms    | 969 ms → 40 ms   |
| Rebuild in a session, one file edited | 194 ms → 50 ms    | 917 ms → 153 ms  |
| Rebuild in a session, one file added  | 195 ms → 30 ms    | 940 ms → 122 ms  |
| New session, caches warm              | 2.94 s → 0.16 s   | 16.1 s → 0.71 s  |
| `anhur check`, caches warm            | 2.97 s → 0.13 s   | 15.8 s → 0.65 s  |
| Peak memory                           | 748 MB → 1,119 MB | 1,833 → 1,802 MB |

Peak memory is reached in the first build. Worker threads trade memory for time there: with `workers: false` the first build of the 1,000 document project takes 4.5 s and 417 MB.

### Changed

- **Documents are frozen** after validation, a transform and `prepare`. Code that changed a document in a view callback, a plugin `generate` hook or `onSuccess` now gets a `TypeError`; return a new object instead. `transform` and `prepare` still get their own copies.
- **`transform` runs again only when its document changed**, or when a source it read through `ctx.documents()` changed. Set `transformCache: false` on a collection or singleton whose transform reads something else (files, environment variables, the network).
- **Compiled documents are kept on disk** in `.anhur/cache/documents`. A later session restores a document without reading its file when the file's size, times and inode are the same; a file modified in the last seconds, or with new times, is compared by content. This applies to sources whose compiled fields all declare `pure` or `cache`; `cacheDir: false` turns it off.
- **Worker threads** (2 to 6, by the amount of work) compile documents when 128 or more with compiled fields wait, as in a first build. Each worker loads the config file and the compilers itself, so a first build uses more memory. Set `workers: false` in `defineConfig` to turn them off; this is needed for configs whose custom fields keep state in memory that a plugin hook reads.
- A generated file edited by hand while a session runs is rewritten by the first build of the next session, not by the next rebuild. A deleted generated file is still restored by the next rebuild.
- Unused cache entries are removed by the first build of a session and then at most once a minute.
- The field cache key changed: fields compile once more after the upgrade.

### Added

- `workers` in `defineConfig`, `transformCache` on collections and singletons.
- `BuildResult.timings` and `anhur build --timings`: the time of each build stage.
- `@anhur/core/plugin`: `pure` and `shares` on `defineField`, `context.share()` and `context.isShared()` (one computation for several fields of a document).
- `apps/bench`: a benchmark that generates a content project and times cold builds, rebuilds and warm starts.

### Fixed

- `s.toc({ maxDepth })`: a changed `maxDepth` read the table of contents cached for the old value.
- Two sources that include the same file wrote the same field cache entry at once; one write failed with a warning.
- `s.excerpt()` segmented the whole body to count the first characters: slow for long documents.
- `s.toc()` compiled the body a second time. It now reads the headings from the compile of `md.body()` / `m.body()`.
- `s.excerpt()` and `s.metadata()` each parsed the body. They now share one parse.
- `@anhur/assets` checked every copied file and rewrote its manifest twice on every build.
- `@anhur/orama` built every index again on every build. An index is now built again only when a document of its locale changed.

## 0.1.1 — 2026-10-12

### Fixed

- **`@anhur/vite`**: after a content edit in `vite dev`, an SSR page could render the old content and fail to hydrate. There were two causes:
  - Vite told the browser to reload at the same time as the SSR module runner, which drops its modules later, in its own queue.
  - Other plugins could reload the page for the content file before Anhur rebuilt it. `@tailwindcss/vite` does this for files it scans for class names.

  Hot updates for content files and Anhur's output now wait until the rebuild is done and the runnable server environments reloaded the new output. Then Vite and the other plugins update the browser.

- **`@anhur/vite`**: while a build fails, a page that reloads gets the error overlay again. Before, a reload cleared it.

## 0.1.0 — 2026-10-01

A rework of the whole build engine: explicit context instead of global state, a fixed pipeline, safe file handling, and every error reported with its file and field. It contains **breaking changes**; see the migration below. The full design report is in [`reviews/2026-10-01-architecture-report.md`](reviews/2026-10-01-architecture-report.md).

### Migration from 0.0.x

| 0.0.x                                                         | 0.1.0                                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `processors: [mdx(), assets()]`, `integrations: [orama({…})]` | `plugins: [mdx(), assets(), orama({…})]`                                                     |
| `body: m.mdx()` / `body: md.markdown()`                       | `body: m.body()` / `body: md.body()` (`m.mdx()` / `md.markdown()` now compile string fields) |
| `import { MDXContent } from "@anhur/mdx/react"`               | `import { MdxContent } from "@anhur/mdx/react"`                                              |
| `import { build, watch } from "@anhur/core"`                  | `import { build, check, watch, createAnhur } from "@anhur/core/build"`                       |
| `defineIntegration(…)` / `registerIntegration(…)`             | `definePlugin({ name, generate })` from `@anhur/core/plugin`                                 |
| `defineProcessor(…)`, `getDocumentMeta()`                     | `defineField(schema, { kind, compile })` with its `FieldContext`; `doc._meta` in transforms  |
| `.anhur/generated/search/orama.json` + `createSearcher(json)` | `createSearcher(await loadSearchIndex(locale))` from `anhur/generated`                       |
| `assets({ storage: { enabled, … } })`                         | Uploads run in build mode; pass `storage` only when uploading                                |
| `s.toc({ tight })`                                            | `tight` removed                                                                              |

Behavior changes to check:

- **References** stay strings in schema code and transforms. They are checked (and embedded with `embed: true`) after `prepare`, against the final documents.
- **`prepare`** runs before reference and uniqueness checks.
- **Drafts**: a top-level `draft: true` in the file drops the document even when the schema does not declare `draft`.
- **Slugs** derived from file names are transliterated to ASCII (`Straße` → `strasse`, `Здраво` → `zdravo`). Names with no ASCII spelling (Chinese, Arabic, …) need an explicit `slug`.
- **Front matter** must open with exactly `---` (YAML only). `----` is never front matter.
- **Schemas** must produce plain data (strings, numbers, booleans, arrays, objects, `Date`, `Map`, `Set`). A `URL` or class instance is an error with its field path.
- **Asset defaults** are media, fonts and `.pdf`. Add data and document types explicitly: `assets({ extensions: [...DEFAULT_ASSET_EXTENSIONS, ".txt"] })` or `DOCUMENT_ASSET_EXTENSIONS`. Files in `node_modules` or dot-folders are never copied; `allowRemote` accepts only http(s), `//` and `/` URLs.
- **Storage prune** is opt-in, runs only in build mode after publish, and deletes only Anhur's hashed files directly under the prefix.
- **Markdown** HTML is sanitized by default (`allowDangerousHtml: true` to opt out). `documentLink` receives `{ url, path, suffix, target, document }` and Anhur appends `?query#hash`.
- **MDX** rejects `import`, `export … from`, dynamic `import()` and top-level `await` at build time.
- **Search indexes** use a new format: rebuild after upgrading.
- **Output folder**: Anhur refuses to write into a folder with files it did not create (`.anhur-manifest.json` marks its own).
- **Names** of collections, singletons and views must match `^[A-Za-z][A-Za-z0-9_-]*$`.

### Added

- `@anhur/core/build` (`build`, `check`, `watch`, `createAnhur`, `isRelevantChange`) and `@anhur/core/plugin` (`definePlugin`, `defineContentPlugin`, `defineLoader`, `defineField`, link and asset helpers) entry points.
- `anhur check` (validate without writing) and `--json` reports.
- Diagnostics: every problem in every file at once, with code, file, field path and hint (`AnhurBuildError.diagnostics`).
- `s.toc()` built by `markdown()` / `mdx()` from the same pipeline as the body, so anchors always match heading ids.
- Discriminated-union schemas: correct types, variant-aware reference and uniqueness checks.
- Orama: one index per locale, a tokenizer for any script (CJK bigrams, accent and spelling-variant folding), stemmers for 28 languages, typed hits (`AnhurSearchStores`, `AnhurSearchField`).
- Vite: errors shown in the overlay without stopping the dev server, recovery on fix, `server.restart()` support, one content build per edit in `vite build --watch`.
- Markdown: GFM footnotes and in-page anchors, video/audio/picture and responsive images in the default sanitize schema (`DEFAULT_SANITIZE_SCHEMA`).

### Fixed

- Data loss: output, asset and cache folders are owned through manifests; nothing Anhur did not write is deleted.
- Concurrent builds no longer corrupt the output (cross-process lock, one build at a time per session).
- Getters load nested, spaced and non-ASCII ids under Node ESM.
- Watch mode is recursive, ignores its own output, recovers when the first build fails, and never stops on an error.
- Config loading no longer clears Node's `require.cache`; config imports (also outside the project) trigger rebuilds.
- Generated names are validated and collision-checked; generated declarations survive names like `promises` or `configuration`.
- Field cache keys are complete (versions, options, config changes); cached values and warnings round-trip exactly.

### Security

- Front matter can no longer execute JavaScript.
- Asset paths are realpath-contained in the project (or explicit `roots`); dotfiles, `node_modules` and non-allowed extensions are refused.
- SVGs are sanitized with an XML-parser-based allow-list; the dev server sends `nosniff` and a CSP for SVG.
- Markdown is sanitized before linked files are resolved, so removed elements never publish files.

### Packaging

- `zod` and `@anhur/core` are peer dependencies; `effect` is pinned; `@effect/platform-node` (and its `redis` peer) is replaced by `@effect/platform-node-shared`.
- Published packages no longer include source maps.
- Node `^22.18.0 || >=24.11.0`.
