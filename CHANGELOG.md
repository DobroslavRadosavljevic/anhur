# Changelog

All `@anhur/*` packages are released together with the same version.

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
