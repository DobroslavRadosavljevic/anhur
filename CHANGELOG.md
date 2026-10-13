# Changelog

All `@anhur/*` packages are released together with the same version.

## Unreleased

A rework of the build engine for sites with thousands of files. A build now does work only for what changed. Measured with the benchmark in [`apps/bench`](apps/bench) on generated projects (MDX posts, Markdown pages, JSON products, one image per four documents, views, search), with Bun on an Apple M3 Max. Each number is the median of its runs; every "new process" row starts a new process, and its time is that of the build inside it.

| Scenario                                   | 1,000 documents | 5,000 documents   |
| ------------------------------------------ | --------------- | ----------------- |
| First build, no caches                     | 8.24 s → 2.98 s | 37.9 s → 10.8 s   |
| Rebuild in a session, nothing changed      | 204 ms → 13 ms  | 928 ms → 43 ms    |
| Rebuild in a session, one body edited      | 207 ms → 47 ms  | 950 ms → 189 ms   |
| Rebuild in a session, one title edited     | 192 ms → 32 ms  | 935 ms → 143 ms   |
| Rebuild in a session, one file added       | 196 ms → 35 ms  | 936 ms → 151 ms   |
| New process, caches warm                   | 3.46 s → 0.30 s | 15.7 s → 0.94 s   |
| `anhur check` in a new process             | 3.61 s → 0.31 s | 15.5 s → 0.82 s   |
| New process after a checkout (new times)   | 3.50 s → 0.43 s | 15.4 s → 1.69 s   |
| Peak memory of the first build             | 434 → 911 MB    | 1,134 → 1,463 MB  |
| Peak memory of a session that only rebuilds | 769 → 454 MB    | 2,023 → 1,301 MB  |

The first build uses more memory: each worker thread loads the config and the compilers. `workers: false` gives that memory back; the first build is then slower.

### Changed

- **Documents are frozen** after validation, a transform and `prepare`, also below a Zod `.readonly()`. Code that changed a document in a view callback, a plugin `generate` hook or `onSuccess` now gets a `TypeError` with a hint; return a new object instead. The lists plugins and hosts get are frozen too (`ctx.sources`, `source.documents`, `BuildResult.sources`, `BuildResult.watch`): copy a list before you sort it. `transform` and `prepare` still get their own copies.
- **`transform` runs again only when its document changed**, or when a source it read through `ctx.documents()` changed. Set `transformCache: false` on a collection or singleton whose transform reads something else (files, environment variables, the network).
- **An unchanged document is the same object in every build of a session.** This also holds when a `prepare` hook or a transform runs again and gives the same data (same values, same key order).
- **Validated documents are kept on disk** in `.anhur/cache/documents`. A later session restores a document without reading its file when the file's size, times and inode are the same; a file modified in the last seconds, or with new times (a checkout), is read once and compared by content. Documents are validated again when one of these changed:
  - the config file, or a module it imports that is not an installed package (relative paths, package `imports`, workspace packages, `paths` aliases under Bun);
  - the lockfile, or the entry file of an installed package the config imports;
  - the schema, a loader, a plugin, or a file a field reported (`addDependency`, assets; compared by size, times and inode).

  A source is stored when every compiled field declares `pure` or `cache` and the loader of the file is pure. `BuildResult.notStored` and `anhur build --timings` name the sources that are not, with the reason. Set `documentCache: false` on a collection or singleton whose schema reads something else when it runs (the clock, an environment variable, the network); `cacheDir: false` turns every disk cache off.
- **`dev` and `build` have their own cache folders** (`.anhur/cache/documents/<mode>`, `.anhur/cache/fields/<mode>`), so a build after a dev session does not remove what the next dev session needs.
- **Worker threads** compile documents when that is faster. With the default (`workers: true`) and 128 or more documents with cached compiled fields waiting, Anhur validates some in the main thread to learn what one costs, and starts 2 to 6 workers when the rest would take longer than about a second. `workers: <number>` starts that many without measuring. Each worker loads the config file and the compilers itself, and runs the `setup` hook of every plugin, so a first build uses more memory. Set `workers: false` for configs whose custom fields keep state in memory that another part of the config reads, or that compute a value at load time (a build id from the clock) that documents use through a function. Sources with `documentCache: false` are validated in the main thread.
- **Closing a session or a watcher stops its work.** Worker threads are stopped before `close()` resolves. A document that blocks a worker thread fails the build after 15 minutes with an error on each file of its batch; workers that cannot load the project are given up on after 30 seconds, once per project.
- **The result of a view, index or group is kept in a session** while the documents it is made from stay the same. Set `generate: { cache: false }` when `where`, `select`, a key function or `compare` reads something else.
- **Content globs** are matched by Anhur's own matcher, with the same result on Bun and Node. Names are compared in Unicode NFC. Differences from before:
  - These patterns are now a `config-invalid` error with the reason: negation (`!a.md`, `!(a).md`), absolute patterns, patterns that leave the folder with `..`, ranges in braces (`{1..3}`), POSIX classes (`[[:alpha:]]`), and an `include` pattern that ends with `/`.
  - A symbolic link to a folder is entered only when a pattern names it (`guides/*.md`), not through `*` or `**`. A link back to the content folder is not entered.
  - On macOS and Windows every part of a pattern ignores case (before: only the parts with wildcards).
  - A folder Anhur has no permission to read is left out with a warning. A folder that cannot be listed for another reason fails the build.
- **The output folder**: the writer refuses to write or delete through a symbolic link that leads out of the folder. A folder without a manifest is taken over only when all its files have names that Anhur 0.0.x wrote.
- **`anhur watch --json`** prints one JSON line per build (before: the flag had no effect).
- **Field contexts have `share()` and `isShared()`**. Code that builds a `FieldContext` by hand (a test double for a custom field) must add both.
- **`transformCache`, `documentCache`, `generate.cache` and a loader's `pure` must be booleans.** Another value is a `config-invalid` error.
- **`fingerprint()`** no longer includes the `lastIndex` of a regular expression, and `StageTiming.stage` is a union of the stage names.
- A generated file edited by hand while a session runs is rewritten by the first build of the next session, not by the next rebuild. The first build of a session compares every generated file by content. A deleted generated file is still restored by the next rebuild.
- Unused cache entries are removed by the first build of a session and then at most once a minute.
- The cache formats changed: fields compile once more after the upgrade.

### Added

- `workers` in `defineConfig`; `transformCache` and `documentCache` on collections and singletons; `generate.cache` on views, indexes and groups; `pure` on loaders.
- `BuildResult.timings` (time of each build stage), `BuildResult.reuse` (how many documents were unchanged, compared by content, or validated) and `BuildResult.notStored`; `AnhurBuildError.timings` (the stages a failed build ran). `anhur build --timings` prints them.
- `@anhur/core/plugin`: `pure` (`true` or `{ key }`) and `shares` on `defineField`, `context.share()` and `context.isShared()` (one computation for several fields of a document).
- `@anhur/assets`: `createAssetsFolderState()` and a fourth parameter of `copyAssets` / `pruneAssets`: with it, a build does not read the assets folder again while the folder is as the last build left it.
- `@anhur/orama`: `createSearchMemory()` and a third parameter of `generateSearchModules`: with it, an index is built again only when a document of its locale changed.
- `apps/bench`: a benchmark that generates a content project and times first builds, rebuilds and new sessions, each new session in its own process.

### Fixed

- `s.toc({ maxDepth })`: a changed `maxDepth` read the table of contents cached for the old value.
- An invalid `Date` in a cached field value came back as 1 January 1970.
- A damaged cache entry could fail the build. It is now compiled again. `anhur check` no longer deletes such an entry.
- Two sources that include the same file wrote the same field cache entry at once; one write failed with a warning.
- A file that a field read (`addDependency`, an asset) and that was replaced by another file with the same size and time was taken as unchanged.
- The `cause` of an error from a custom field or loader keeps its `code`, `line` and own `cause` in every case.
- After a failed, killed or interrupted write, a generated file with the old content and the same size was taken as written, in every later build. The manifest now records a hash only for content that is on disk. (This was also so in 0.1.1.)
- An interrupted build went on writing after it gave the output lock back.
- Temp files of a killed build stayed in the output folder, and a folder with only such files was refused.
- `s.excerpt()` segmented the whole body to count the first characters: slow for long documents.
- `s.toc()` compiled the body a second time. It now reads the headings from the compile of `md.body()` / `m.body()`, when that body compiles in the same build.
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
