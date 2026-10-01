# Anhur architecture rework — full report

Branch `rework/architecture` (uncommitted), compared with `main` at `bf6db0c`.

Related documents:

- [`2026-10-01-full-review.md`](2026-10-01-full-review.md) — the first review: findings C1–C6, H1–H28, M*, T*.
- [`2026-10-01-rework-plan.md`](2026-10-01-rework-plan.md) — design decisions, progress, and the second review round.

---

## 1. Summary

The product idea did not change. Content files in the repo become typed modules imported from `anhur/generated`. Each package keeps its role. What was rebuilt is how Anhur gets there.

The first review found four systemic problems:

1. **Unsafe file operations.** Folders were deleted without an ownership check. Files were copied from anywhere on disk. Front matter could execute JavaScript.
2. **Hidden global state.** Two AsyncLocalStorage singletons, a global integration registry, and a jiti cache that was actually Node's `require.cache`.
3. **A pipeline order that fought the types.** References were resolved before transforms but typed after them. Hooks ran before the publish they depended on. Assets were uploaded after the output that pointed at them went live.
4. **No validation layer between user config and codegen.** Names went unescaped into generated JS and file paths. The first error aborted the build. Some errors killed watch mode.

The rework answers each one structurally:

| Problem                | Architectural answer                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unsafe file operations | Ownership manifests for every folder Anhur writes. Realpath-contained, allow-listed asset reads. A hand-written YAML front-matter splitter.                         |
| Global state           | Explicit context objects (`FieldContext`, `FieldSession`), Effect services with a runtime per session, and a private jiti instance for each config load.            |
| Pipeline order         | A fixed, documented pipeline. References and uniqueness are checked on the final documents. Publish happens before the hooks that need it.                          |
| No validation layer    | A config resolver with a symbol table, plus a diagnostics model (every error, with file and field path) used by the CLI, the Vite overlay and the programmatic API. |

Two review rounds of five subagents each found about 150 issues. The first round (before the rework) was fixed by the rework itself. The second round, about 75 issues found in the reworked code, was fixed in five parallel lanes, with a regression test for each.

**Numbers:**

|                                                     | Before (`main`)                         | After (branch)                                                              |
| --------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| `@anhur/core` source                                | 53 files, 7,762 lines                   | 53 files, 12,699 lines                                                      |
| Other packages (markdown, mdx, assets, orama, vite) | 26 files, 2,358 lines                   | 35 files, 4,968 lines                                                       |
| `@anhur/core` entry points                          | 1 (`.`), DSL and engine internals mixed | 3 (`.`, `./build`, `./plugin`)                                              |
| Tests                                               | 153 unit + 47 integration               | 142 unit + 89 integration (each targets a confirmed failure)                |
| CI                                                  | none                                    | GitHub Actions: Node 22.18 and 24, every quality gate and the publish gates |
| Lint                                                | bellona (older)                         | bellona 0.5.0, every rule of the used plugins enabled                       |

The extra lines are mostly validation, diagnostics, and safety code: ownership, locks, containment, sanitizing, cache keys.

---

## 2. Before and after at a glance

| Area                                                    | Before                                                                                                             | After                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Extension model**                                     | `processors: [...]` for fields, `integrations: [...]` for post-build work, a global `registerIntegration` registry | One `plugins: [...]` array. A plugin is a plain object with hooks: `setup`, `loaders`, `assets`, `headings`, `generate`, `beforePublish`, `afterPublish` |
| **Field helpers** (`m.mdx()`, `a.image()`, `s.slug()`…) | Zod `.transform()`s that read ambient AsyncLocalStorage state during validation                                    | Zod schemas carrying a marker (`.meta({ anhur })`). The engine compiles marked fields **before** Zod with an explicit `FieldContext`                     |
| **References**                                          | Resolved during validation into objects, but typed as `string`                                                     | Stay strings through validation and transforms. Checked and embedded after `prepare`, against the final documents                                        |
| **Config handling**                                     | Checks only inside `defineConfig()`. The first one threw at import time                                            | `resolveProject()` always runs, collects every problem, and builds a resolved, normalized project model                                                  |
| **Errors**                                              | Tagged errors with empty messages, "Invalid config" for anything late, first error only                            | `Diagnostic { code, severity, message, file, fieldPath, source, hint }`, all of them, formatted everywhere                                               |
| **Engine**                                              | `services/builder.ts` doing everything, plus module-level state                                                    | Effect services (`Engine`, `Collector`, `ConfigLoader`, `OutputWriter`, `FieldCache`, `Watcher`) behind one `ManagedRuntime` per session                 |
| **Output**                                              | Write to `<out>.building`, then swap with `<out>.prev` (fixed paths, races, delete without ownership)              | Diff-write into the real folder: per-file atomic renames, an ownership manifest, a cross-process lock, `index.js` written last                           |
| **Generated names**                                     | Interpolated straight into code and file names                                                                     | Validated, collision-checked (symbol table), JSON-escaped. Module names are an ASCII slug plus a hash                                                    |
| **Values in modules**                                   | `JSON.stringify` (Date→string while typed `Date`, Map/Set→`{}`, BigInt crash)                                      | A JS-literal serializer that round-trips Date/Map/Set/BigInt/undefined/-0. Anything else is a diagnostic with its field path                             |
| **Watch**                                               | Not recursive. Roots computed once. No event filter (rebuild loops). One defect stopped it                         | Recursive, filtered, re-synced after every build. Watches from the moment the config loads. Never dies on a defect                                       |
| **Vite**                                                | Alias + its own dev watch module. Errors gave an empty message and dev failed to start                             | `resolveId`, per-server state, the error overlay, recovery, Vite's own HMR on diff-written files                                                         |
| **Assets**                                              | Copied from anywhere (`../.env`, symlinks). Pruned every file in the folder. Uploaded after publish                | Core owns the read policy. The plugin copies with a manifest, uploads before publish, and prunes only its own keys after publish, in build mode only     |
| **Markdown**                                            | Raw HTML passed through (XSS)                                                                                      | Sanitized by default. Assets are resolved only for elements that survive sanitizing                                                                      |
| **MDX**                                                 | `import` compiled but crashed at render                                                                            | Imports, dynamic `import()` and top-level `await` are rejected at build time with the line number                                                        |
| **Search**                                              | One English-tokenized index for all locales. JSON file read by path                                                | One index per locale, a Unicode tokenizer for any script, optional stemmers, a generated `loadSearchIndex(locale)`, typed hits                           |
| **Effect platform**                                     | `@effect/platform-node` (pulled a required `redis` peer)                                                           | `@effect/platform-node-shared`, with `effect` pinned exactly                                                                                             |

---

## 3. Package and entry-point layout

### Before

`@anhur/core` had one entry point. It exported the user DSL along with dozens of engine internals: `resolveViews`, `createBuildContext`, `withBuildContext`, `registerIntegration`, `defineProcessor`, naming helpers, codegen helpers. Users, plugins and the CLI all reached into the same module. Core source was flat: `build.ts`, `build-context.ts`, `publish-dir.ts`, `integrations.ts`, `processors.ts`, `relations.ts`, `views.ts`, `services/{builder,config-loader,content-collector,generator,watcher}.ts`, `schema/*`, `loaders/*`, `cli/*`.

### After

```
@anhur/core            user DSL: defineConfig/defineCollection/defineSingleton,
                       views, schema helpers, public types, AnhurBuildError
@anhur/core/build      engine for hosts: build, check, watch, createAnhur,
                       isRelevantChange, diagnostics formatting
@anhur/core/plugin     plugin authoring: definePlugin, defineContentPlugin,
                       defineLoader, defineField, FieldContext, link/asset helpers,
                       rehypeLinkedAssets, headings types, fingerprint, text helpers
anhur (bin)            CLI: build | check | watch  (--root, --config, --json)
```

Core source is grouped by responsibility:

| Folder                                                  | Owns                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `define/`                                               | The DSL and all type-level inference (`infer.ts`: `GetTypeByName`, `RemapEmbeddedRefs`, `AlignEmbeddedRefs`, `UnboundEmbed`, …) |
| `schema/`                                               | Field markers (`field.ts`), the schema walker (`walk.ts`), built-in fields, text/TOC extraction                                 |
| `plugin/`                                               | The plugin contract (`types.ts`), factories, link classification, linked-asset rewriting                                        |
| `engine/`                                               | Resolver, services, pipeline stages, codegen, serializer, output, caches                                                        |
| `build/`, `cli/`                                        | Promise-based host API and the CLI on top of the engine                                                                         |
| `loaders/`                                              | Front-matter splitter, YAML/JSON loaders                                                                                        |
| `diagnostics.ts`, `naming.ts`, `document.ts`, `mime.ts` | Shared primitives                                                                                                               |

The other packages are now plugins built on `@anhur/core/plugin`, and depend on core only through it (it is a peer dependency):

| Package           | Before                                                                                    | After                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `@anhur/markdown` | `processors: [markdown()]`, `md.markdown()` for the body, its own relative-link rejection | `plugins: [markdown()]`, `md.body()` / `md.markdown()`, shared `rehypeLinkedAssets`, sanitizer, heading extraction                |
| `@anhur/mdx`      | `m.mdx()` for the body, `MDXContent`                                                      | `m.body()` / `m.mdx()`, `MdxContent` / `useMdxComponent` / `getMdxComponent`, import rejection, heading extraction                |
| `@anhur/assets`   | remark plugin that copied linked files, `resolve.ts` with no containment                  | The `assets()` plugin as an **asset host**. Core resolves and checks paths; the plugin copies, sanitizes SVGs, uploads and prunes |
| `@anhur/orama`    | An integration registered globally, writing `search/orama.json`                           | A typed content plugin that emits `search.js` + `search/<locale>.js` through `generate`                                           |
| `@anhur/vite`     | Alias + its own dev watcher (`dev-watch.ts`)                                              | `resolveId` + a core session; asset middleware and client-output copy                                                             |

---

## 4. The build pipeline

### Before (roughly)

```
load config (jiti, shared require.cache) → collect files (gray-matter, JS front matter allowed)
→ validate with Zod, where field transforms read AsyncLocalStorage state and
  references were resolved into objects mid-validation (first error aborts)
→ transforms (ctx.documents order-dependent) → prepare → views
→ codegen into <out>.building → onSuccess → integrations (given the .building path)
→ swap .building ↔ out (.prev) → asset copy / CDN upload / prune → complete
```

Consequences: references typed `string` but objects at runtime, `onSuccess` firing for builds that later failed, live modules pointing at CDN files not uploaded yet, and races between concurrent builds on fixed staging paths.

### After

```
 1. resolve      load config (fresh jiti per load) → resolveProject(): validate names,
                 paths, plugins, locales, views; symbol table; embed-order graph
                 (cycles rejected); plugin setup()
 2. discover     glob per source (node_modules / hidden folders never traversed),
                 NFC ids, duplicate / case-insensitive id check, stray-locale warnings
 3. load         front matter split (YAML only), YAML/JSON loaders, plugin loaders;
                 loader output must be plain data
 4. compile      walk the schema on the input side; compile marked fields with an
                 explicit FieldContext (cached on disk, effects recorded)
 5. validate     Zod on the compiled input; every issue with its path; output must be
                 plain data
 6. transform    each transform sees the same frozen snapshot (ctx.documents);
                 ctx.skip(); output must be plain data
 7. drafts       draft: true (from the file, even if undeclared) and skips dropped
 8. prepare      hook may edit / drop final documents
 9. relations    references checked against final targets (also those a transform
                 renamed); embeds resolved in dependency order; variant-aware
10. uniqueness   per field path, typed values, variant-aware
11. derive       views / indexes / groups on final documents
12. generate     plugins emit modules / files (e.g. Orama indexes)
13. plan         codegen in memory: modules, getters, index.js / index.d.ts
14. commit       ownership check → lock (+ heartbeat) → beforePublish (asset copy,
                 CDN upload) → diff-write with manifest → afterPublish (prune)
                 → onSuccess → complete (real outputDir) → field-cache GC
```

Properties this order guarantees:

- **Types match runtime.** Embeds happen after transforms and `prepare`, on the shape the types describe.
- **Nothing published is half-ready.** Assets are uploaded before the modules that reference them, and pruned only after the new modules are live.
- **Hooks see reality.** `onSuccess` and `complete` run only after a successful publish, with the real output folder.
- **All-or-nothing.** Any error before the commit stage writes nothing; the previous output stays.
- **One build at a time per session.** A semaphore serializes builds, so an older build can never publish over a newer one.

---

## 5. Core design changes in detail

### 5.1 No ambient global state

| Removed                                                                                               | Replaced by                                                                                          |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Two AsyncLocalStorage singletons on `globalThis` (build context, document meta / `getDocumentMeta()`) | `FieldContext` passed to each field compiler; `FieldSession` per build; `doc._meta` in transforms    |
| Global integration registry (`registerIntegration`, `getIntegrationHandler`)                          | Plugins are values in `defineConfig({ plugins })`                                                    |
| jiti with `moduleCache: true` (= Node's `require.cache`, cleared on every load)                       | A fresh jiti per load (`moduleCache: false`, `fsCache: false`); Anhur packages are loaded natively   |
| gray-matter (JS engine, unbounded cache, shared `data` objects)                                       | A hand-written front-matter splitter plus the `yaml` package (unique keys, alias limits, merge keys) |
| Fixed `.building` / `.prev` paths                                                                     | Per-file temp names plus a lock file                                                                 |

Everything stateful now lives inside a **session**: `createAnhur()`, a watch run, or a Vite server. Each session has its own `ManagedRuntime`, document cache, asset-hash cache and build semaphore. Two sessions in one process never share state.

### 5.2 Field model: markers, compile-before-validate, explicit context

**Before:** a helper such as `a.image()` was a Zod transform. It looked up the current build and document through AsyncLocalStorage and did I/O during `safeParse`. References were turned into objects inside validation, so user `.transform()` / `.refine()` code saw objects while the types said `string`.

**After:**

- **Markers.** `defineField(zodSchema, spec)` attaches a spec through Zod 4's registry (`.meta({ anhur })`), with a symbol fallback for older Zod 4.1 builds. Markers survive `.optional()`, `.default()`, `.describe()` and similar wrappers.
- **The walker.** `schema/walk.ts` has three passes:
  - `analyzeSchema` finds static field locations (and reports unsupported placements as config errors);
  - `walkInput` visits the input side (pipes, defaults, discriminated unions, catchall, recursion);
  - `walkData` visits final data, following only the union variant each document selects.
- **Compile kinds.**
  - **Compile fields** (slug, raw, excerpt, metadata, toc, Markdown/MDX bodies, images, files) run **before** Zod with a `FieldContext`. The context gives the document, field path, body, mode, config fingerprint, plugin lookup, `resolveLink`, `emitAsset`, `addDependency` and `warn`. Zod then validates the compiled value, so user schema code sees exactly the typed value.
  - **Marker fields** (`s.reference()`, `s.unique()`) stay plain strings through validation and transforms. Separate passes check and resolve them.
- **Recorded effects.** Every effect a field has (assets, dependencies, warnings) is recorded per document. Only documents that survive drafts and skips contribute assets to the build, so draft images are never uploaded.

### 5.3 Config resolution and validation layer

`resolveProject()` (`engine/resolve.ts`) always runs, whatever object the config exports. It:

- validates sources, views, plugins, loaders, localization, generate options, paths (output and cache dirs must not overlap the project, content or each other), and names (`^[A-Za-z][A-Za-z0-9_-]*$`);
- computes every generated export, type and file name in one naming module (`pluralize`, transliterating slugs) and registers them in a **symbol table** with reserved names, so collisions are reported instead of overwriting each other;
- builds the **embed-order graph** and rejects embed cycles;
- derives per-source reference and unique locations, default `lookupBy`, list-omit and sort settings;
- reports **every** problem at once as diagnostics.

The result, `ResolvedProject`, is the only thing later stages read. User config objects are never interpreted twice.

### 5.4 Diagnostics as the error model

**Before:** tagged Effect errors whose `.message` was empty, late failures relabeled "Invalid config", only the first content error shown, and defects (plain throws) that killed watch mode.

**After:** every stage returns `Diagnostic`s with 27 codes (`validation-failed`, `reference-failed`, `unique-conflict`, `output-unsafe`, `asset-failed`, …). Each has a severity, a message, the file, the field path, the source and a hint.

- A build fails with `AnhurBuildError`, which carries every diagnostic and a formatted message (`notes/b.md › title: …`).
- Warnings flow into `BuildResult.warnings`. Field warnings are replayed from cache, so they are not lost on cached builds.
- Defects are converted to `internal` diagnostics at the session boundary. Watch and Vite never die.
- The CLI prints the formatted list, or `--json` to stdout, and exits 1 on errors.

### 5.5 Engine as Effect services

The engine is Effect v4 internally; the public API is Promise-based. Each service has one file and one responsibility:

| Service        | Responsibility                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConfigLoader` | Find and load the config, follow relative imports (also outside the project) to fingerprint and watch them, resolve the project, run plugin `setup` with timeouts |
| `Collector`    | Discover files, load them, compile fields (field cache, effect replay), validate with Zod; per-session document cache keyed by source and path                    |
| `FieldCache`   | On-disk cache of compiled fields (atomic writes, versioned format, GC that deletes only files it owns)                                                            |
| `Engine`       | Orchestrates the pipeline, owns session state, the build semaphore and watch targets                                                                              |
| `OutputWriter` | Ownership check, cross-process lock with heartbeat, diff writes, manifest                                                                                         |
| `Watcher`      | Recursive, filtered file watching with debounce; re-syncs targets after every build                                                                               |

User code (transforms, hooks, plugins, field compilers) runs inside the services with timeouts. Typed failures become diagnostics; defects are caught at the edge.

### 5.6 Output and publish model

**Before:** stage the whole output in `<out>.building`, then swap it with `<out>.prev`. Fixed paths caused races. Directories were deleted with no ownership check (`outputDir: "src"` deleted user code).

**After** (`OutputWriter`):

- **Ownership.** `.anhur-manifest.json` marks a folder as Anhur output. A folder with foreign files is refused (`output-unsafe`), and older Anhur output is adopted only if it looks generated. `anhur check` runs the same check.
- **Lock.** `<outputDir>.lock` is created atomically (hard link of a fully written file), names its pid, host and token, is refreshed every minute, and is taken over only when stale (dead pid, too old, or unreadable for over 30 s).
- **Diff writes.** Only changed files are written, each via temp file plus rename. `index.js` is written last. Unchanged files whose size changed on disk (edited by hand) are rewritten.
- **Deletes.** Only paths in the previous manifest are ever removed. New paths are recorded before they are created, so an interrupted build leaves nothing untracked. Case-only renames remove the old name first, which is safe on case-insensitive disks.

Diff writes are also what makes Vite HMR work: Vite sees only real changes.

### 5.7 Codegen and serialization

- **Module names.** Per-document modules are named `ascii-slug-<10 hex>`, so nested, spaced and non-ASCII ids load under Node ESM. Before, `encodeURIComponent` ids broke `getX()` in Node SSR.
- **Getters.** Each getter maps `locale\0field\0value` exactly to a lazy `import()`. A string query tries `id`, then `lookupBy` fields. Duplicates are errors; an id/slug clash between two documents is a warning. Localized getters require `locale` in their types.
- **Serializer.** `toJsLiteral` round-trips Date, Map, Set, BigInt, `undefined`, NaN, ±Infinity and -0, and writes `__proto__` as a computed key. Cycles, class instances and nesting deeper than 1000 levels become `serialize-failed` with a field path. A separate plain-data check (`plain-data.ts`) catches the same values earlier, at load, validation and transform time.
- **Declarations.** Every interpolated name is JSON-escaped. Comments are escaped. The `index.d.ts` header uses private aliases (`__AnhurConfig`, `__AnhurPromise`, `__AnhurArray`), so collections named `promises`, `arrays` or `configuration` cannot shadow them.
- **Plugin modules.** A plugin emits modules through `emitModule({ path, code, exports, dts })`. Paths are checked, exports are validated against the symbol table, `index.js` / `index.d.ts` are reserved, and collisions name the plugin.

### 5.8 Caching

| Layer                                         | Key                                                                                                                                                                                                               | Invalidation                                                                                                                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session document cache** (memory)           | source name + path                                                                                                                                                                                                | File hash, project fingerprint (config sources + mode + plugin versions), public asset base, id/locale, dependency stats. Rebound to the current config objects on reuse; dropped when validation fails |
| **Field cache** (disk, `.anhur/cache/fields`) | Core version, field kind and cache version, plugin version, plugin cache key (options fingerprint; config fingerprint when options contain functions), input value, field path, body, file meta, mode, asset base | Dependency stats and asset hashes are re-checked on replay. Values the codec cannot round-trip are never cached. `anhur check` never writes it. GC after each build deletes only unused entries it owns |
| **Asset hashes** (memory)                     | real path + size + mtime + ctime + inode                                                                                                                                                                          | Re-hashed when any of these change; copies are verified against the hash                                                                                                                                |

`fingerprint()` is canonical: arrays are handled correctly (this was a cache-collision bug), Map/Set order counts, common built-ins are keyed by content, symbols by identity, and shared objects are memoized.

### 5.9 Watch and dev

- Content roots are watched recursively. Single files (config imports, assets outside roots, field dependencies) are watched through their folders.
- `isRelevantChange()` ignores the output, lock, cache and assets folders, dotfiles, editor temp files and `node_modules`. It resolves symlinked or case-different event paths before deciding.
- Targets are stored as soon as the config loads, so a session whose first build fails still rebuilds when content is fixed. Watchers start during the first build, so edits made then are not lost.
- Watchers whose folder disappeared are restarted on the next sync.
- The Vite plugin uses the same targets with Vite's watcher, queues events during the first build, keeps per-server state (it survives `server.restart()`), shows errors in the overlay and reloads on recovery. `vite build --watch` runs one content build per edit.

### 5.10 Plugin system

```ts
type AnhurPlugin = {
  name;
  version?;
  setup?(ctx); // validate options with ctx.error(message, hint)
  loaders?; // new file types
  assets?: AssetHost; // at most one: base, devBase, dir, roots, extensions, transformVersion
  headings?; // body heading extractor used by s.toc()
  generate?(ctx); // emitModule / emitFile from final documents
  beforePublish?(ctx); // e.g. copy and upload assets
  afterPublish?(ctx); // e.g. prune
};
```

- **Typed factories.** `defineContentPlugin` returns a deferred factory. `defineConfig` infers `TContent` from the sibling `content` array and passes it to the plugin as `NoInfer<TContent>`, so `orama({ collections: { posts: { index: (doc) => … } } })` types `doc` with no generics. A `TPlugins` generic keeps the plugin tuple in `typeof config`, so plugins can carry types into generated declarations (typed search stores).
- **Field ↔ plugin binding.** `defineField({ requires: "mdx" })` makes a missing plugin a config error that names it.
- **Asset host.** Core decides _whether_ a file may be read and what it is named (realpath containment in the project or explicit `roots`, no dotfiles, no `node_modules`, extension allow-list, content hash). The plugin decides _what happens_ to it (copy, SVG sanitize, upload, prune).

---

## 6. Package-level architecture changes

### `@anhur/markdown`

Pipeline: remark-parse → GFM → user remark plugins → remark-rehype → rehype-raw → **sanitize** (GitHub schema plus media and responsive images; `DEFAULT_SANITIZE_SCHEMA`) → in-page anchor fix (footnotes, raw `id`s) → **linked assets** (only for elements that survived) → rehype-slug → user rehype plugins → HTML.

- `documentLink` receives `{ url, path, suffix, target, document }`; Anhur appends `?query#hash`.
- Cache keys include every output-shaping library version.

### `@anhur/mdx`

- Function-body output, rendered by `MdxContent` with an LRU cache of components.
- ESM is checked at build time: `import`, re-exports, dynamic `import()` and top-level `await` are rejected with the line number.
- Options that do nothing with function-body output (`jsxImportSource`, `pragma*`, …) are rejected.
- Links are rewritten in markdown, JSX attributes, JSX inside expressions and `export` blocks. Component props are rewritten only when they start with `./` or `../`.
- `.md` files use MDX's Markdown format, with raw HTML kept.

### Table of contents (shared)

`s.toc()` asks the `markdown()` / `mdx()` plugin for the body's headings. The plugin runs the same pipeline up to heading ids, so TOC anchors always match the HTML ids. A built-in GFM/MDX-aware parser with `github-slugger` is the fallback. Excerpt and word counts parse MDX properly instead of stripping it with regexes.

### `@anhur/assets`

- **Fields:** `a.image({ allowRemote, blur })` (EXIF-oriented size, real blur placeholder, http(s)/root URLs only) and `a.file()` (size, content type).
- **Copy:** into `.anhur/assets` with a manifest, an ownership check, abort-on-first-error, streaming copies verified against the hash, and SVGs sanitized by an XML-parser-based allow-list (namespace-aware, entity-decoded URL checks). The sanitizer version is part of the hash, so switching modes renames files.
- **Storage:** uploaded through files-sdk before publish, with content type and immutable cache headers. Prune is opt-in, build-mode only, runs after publish, and touches only hashed direct children of the prefix.
- **Defaults:** media, fonts and `.pdf`. Data and document types are opt-in (`DOCUMENT_ASSET_EXTENSIONS`).

### `@anhur/orama`

- **Indexes:** one Orama index per locale (monolingual collections in every locale), built and validated by insert at build time, emitted as `search/<locale>.js` (lazy chunks) plus `search.js` with `loadSearchIndex(locale)` and `searchLocales`.
- **Tokenizer:** a Unicode tokenizer for any script (accent folding limited to combining diacritics, spelling-variant folding, CJK bigrams), with optional stemmers for 28 languages loaded lazily. The tokenizer spec is stored in the index.
- **Types:** `AnhurSearchStores` (from each `store()` return type) and `AnhurSearchField`. `index()` is exact; queries are validated.

### `@anhur/vite`

- `configResolved` creates a session (mode and Vite `base` passed to core).
- `resolveId` maps `anhur/generated` to the generated `index.js`.
- `buildStart` builds (`this.error` with formatted diagnostics).
- The dev server rebuilds on relevant events and serves assets (Range, ETag, nosniff, SVG CSP).
- `writeBundle` copies only this build's assets into the client output.

---

## 7. Security model (new)

| Threat                           | Before                                                        | After                                                                                                            |
| -------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Code execution from content      | `---js` front matter ran JavaScript                           | Only YAML front matter; MDX ESM checked at build time (MDX remains trusted code, documented)                     |
| Reading secrets via links/fields | `../.env`, `/etc/hosts`, symlinks copied and uploaded         | Realpath containment, dotfile refusal, `node_modules` refusal, extension allow-list (data files opt-in)          |
| Deleting user files              | `outputDir`, `assets.dir` and the CDN prefix pruned wholesale | Manifests everywhere; delete only what Anhur wrote; refuse foreign folders; prune only hashed keys after publish |
| XSS from Markdown                | Raw HTML passed through                                       | Sanitized by default; assets only for surviving elements; `rehypePlugins` after sanitize documented              |
| XSS from SVG assets              | Not handled (then a bypassable regex sanitizer)               | XML-parsed allow-list; dev serves SVG with CSP + nosniff; production headers documented                          |
| XSS from remote URLs             | Any scheme                                                    | Only http(s), `//`, `/`                                                                                          |
| Code injection via names         | Names interpolated into JS/TS and paths                       | Name validation, symbol table, JSON escaping, comment escaping                                                   |
| Host process corruption          | Cleared `require.cache`                                       | Private jiti instance                                                                                            |

---

## 8. Public API changes (migration)

| Before                                            | After                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `processors: [...]`, `integrations: [...]`        | `plugins: [...]`                                                 |
| `m.mdx()` / `md.markdown()` for the body          | `m.body()` / `md.body()` (the old names now mean string fields)  |
| `MDXContent`                                      | `MdxContent`, `useMdxComponent`, `getMdxComponent`               |
| `build`, `watch` from `@anhur/core`               | `@anhur/core/build` (also `check`, `createAnhur`)                |
| `defineIntegration`, `registerIntegration`        | `definePlugin({ generate })`, `defineContentPlugin`              |
| `defineProcessor`, `getDocumentMeta()`            | `defineField` with `FieldContext`; `doc._meta` in transforms     |
| `search/orama.json` + `createSearcher(json)`      | `createSearcher(await loadSearchIndex(locale))`                  |
| `assets({ storage: { enabled } })`                | Uploads run in build mode; pass `storage` only when uploading    |
| `s.reference()` value is an object in schema code | Always a string until the relations pass; embedded in the output |
| `s.toc({ tight })`                                | `tight` removed (it had no effect on the data)                   |
| CLI `build`, `watch`                              | Plus `check`; `--root`, `--config`, `--json`                     |

Behavior changes worth knowing:

- `prepare` now runs before references and uniqueness are checked.
- `draft: true` works without being declared.
- Derived slugs are transliterated to ASCII, and names with no ASCII spelling need an explicit `slug`.
- Front matter opens only with an exact `---`.
- The asset extension defaults are narrower.
- The search index format changed (rebuild).
- Published packages ship no source maps.

---

## 9. Tooling and release

- **Lint:** bellona 0.5.0 with every rule of the used plugins enabled. This shapes the code:
  - one `Context.Service` per `*.service.ts`;
  - `Effect.fn` names in `Service.method` form;
  - `Predicate` instead of untyped `typeof`;
  - a SAFETY comment on every cast;
  - timeouts on external I/O;
  - no generic module names.
- **Turbo:** a transit node, so dependency changes invalidate cached lint/test/typecheck results. A `generate` task makes the playground typecheck work on a clean checkout. Environment variables are declared for the playground build.
- **CI** (`.github/workflows/ci.yml`): Node 22.18 and 24 run, in order: `check:root` (root scripts, turbo.json, workflow), format, lint, typecheck, unit tests, integration tests, then the publish gates.
- **Release** (`scripts/release.ts`):
  - publishes from a staged temp copy (the workspace `package.json` is never modified);
  - resumes by skipping versions already on npm;
  - publishes prereleases under `next`;
  - parses `bun.lock` as JSON;
  - publishes peers as `^version`;
  - gates on exports, dist files, the CLI shebang, tarball contents, and source maps that would point at unshipped files.
- **Effect:** `effect` pinned exactly; `@effect/platform-node-shared` instead of `@effect/platform-node` (no `redis` peer for consumers).

---

## 10. Verification

All of the following were run on the branch:

- **Clean checkout** (only git-visible files, no `dist`, no generated output), every CI step passes:
  - install with `--frozen-lockfile`;
  - `check:root`, format and lint;
  - typecheck, 14/14 tasks;
  - 142 unit and 89 integration tests;
  - `release.ts verify`.
- **Playground:** the production build works. On the dev server, a real post page's TOC links match its heading ids exactly, a draft page returns 404, and the log has no errors.
- **Regression tests:** every confirmed review finding has one, mostly in `engine-regressions`, `dsl-regressions`, `types-regressions`, `asset-policy`, `links-regressions` and the per-package suites.
- **Docs:** the README examples are typechecked against the real types.

---

## 11. Known limits and open items

- **Not committed.** About 310 changed paths on `rework/architecture`. The CI workflow has never run on GitHub.
- **Version.** The API changed in breaking ways, but every package is still `0.0.14`. A bump (for example `0.1.0`) is a release decision.
- **Not tested:**
  - Windows (paths, case, drive letters);
  - Linux file watching (the clean-checkout CI run was on macOS; GitHub CI will cover Linux);
  - Vite 6 and 8 (only 7.3.6 is installed);
  - real-bucket storage uploads (only a fake client; MinIO compose file available).
- **By design:**
  - MDX is trusted code (`new Function`). It cannot render on edge runtimes or under a CSP without `'unsafe-eval'`.
  - Config imports through path aliases or packages are not watched.
  - Running `vite build` while `vite dev` uses the same assets folder is unsupported (documented).
- **Optional follow-ups suggested by the lanes:**
  - Move the small `cache-key.ts` duplicated in markdown/mdx into `@anhur/core/plugin`.
  - Expose the build's asset file list on `BuildResult.assets` so Vite need not read the manifest.
  - Optionally raise the `zod` peer to `^4.1.13`.
- **Independent review.** `/code-review ultra` (a cloud multi-agent review) has not been run; only you can start it.
