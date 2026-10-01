# Anhur full review — 2026-10-01

Scope: the whole monorepo at commit `bf6db0c`: `packages/{core,vite,mdx,markdown,assets,orama}`, `apps/vite-playground`, `scripts/release.ts`, tooling, and docs (`README.md`, package READMEs, `skills/anhur`).

Method:

- Five read-only review agents, one per lane:
  1. core config/schema
  2. core build pipeline
  3. body and asset packages
  4. Vite/Orama/playground
  5. architecture comparison and tooling
- The agents confirmed suspected bugs with throwaway scripts outside the repo.
- The orchestrator re-checked every critical finding against the code. Steps:
  - read the code;
  - reproduced the Node ESM import failure, the gray-matter `---js` execution and the `jiti.cache === require.cache` identity;
  - ran the full baseline.

**Baseline: everything passes.** Typecheck, lint, format, build, 153 unit tests and 47 integration tests (MinIO included) all pass. The bugs below are in behaviour the tests do not exercise.

Legend:

- **C** = confirmed: the bug was reproduced, or the code path was traced unambiguously.
- **S** = suspected: the cause is inferred and was not reproduced.
- The lane tags `[L1]`–`[L5]` name the lane that reported the finding.
- When two lanes found the same bug on their own, both tags are given.

---

## 1. Executive summary

The product idea is strong: typed folder i18n, light lists plus lazy document modules, build-time views/indexes, atomic output swap, and a CDN asset sync. In several ways it is ahead of velite, content-collections and contentlayer.

The implementation has four systemic problems:

1. **Unsafe file-system operations.** Configurable directories are deleted or pruned without an ownership check. Linked files are copied from anywhere on disk, including `../.env` and symlinks. Frontmatter can execute JavaScript.
2. **Hidden global state.** These are all process-wide:
   - two AsyncLocalStorage singletons on `globalThis`;
   - a global integration registry;
   - a `jiti` cache that is actually Node's `require.cache`, cleared on every config load;
   - gray-matter's unbounded cache;
   - fixed `.building`/`.prev` paths.

   Together they cause cross-build corruption, Vite 8 resolution failures and memory growth.
3. **The pipeline order fights the types.**
   - References are resolved before transforms, but typed after them.
   - Reference fields are objects at runtime but typed as `string`.
   - `ctx.documents()` depends on source order.
   - Hooks run before the publish they depend on.
   - Assets are uploaded after the output that points to them goes live.
4. **No validation layer between user config and codegen.**
   - Names, ids, locales and paths go into generated JS/TS and into file paths without escaping or collision checks.
   - Many content errors become untyped defects. A defect kills watch mode silently.
   - The first error aborts the build.

The architecture rework (section 4) answers all four. Some issues are dangerous now and do not depend on the rework. Section 3 lists them as P0 fixes.

---

## 2. Findings

### 2.1 Critical: data loss, code execution, broken core feature

| # | Finding | Where | Failure | Fix |
|---|---|---|---|---|
| C1 | **`outputDir` has no guard and is deleted recursively** [L2] C | `core/src/publish-dir.ts:40-63`, `services/builder.ts:100-107` | `outputDir: "src"` deleted `src/app.ts` and `src/components/` for good. `"."`, `"content"` or `"cms"` would delete the project, the content or the schemas. | Refuse an output dir that equals or contains the config dir, the root, a content root, the cache dir or the assets dir. Write an ownership marker. Never delete a dir without the marker. |
| C2 | **Asset prune deletes every file in `assets.dir`** [L2][L3] C | `core/src/build-context.ts:285-300`; no `dir` check in `resolveAssetsConfig` (`:179`) | `assets({ dir: "." })` deleted `anhur.config.ts` and `package.json`. `dir: "public"` deletes all user files in `public/`. The dev middleware would also serve the whole dir, `.env` included. | Prune only files listed in a manifest that Anhur wrote. Refuse a shared dir or a dir that overlaps the project. |
| C3 | **Path traversal and secret exfiltration** through body links, `a.image()` and `a.file()` [L3] C | `assets/src/resolve.ts:51-63` (`path.resolve` with no containment check); `copyFile` follows symlinks (`build-context.ts:268`) | `[x](../.env)` was emitted as `/anhur-assets/.env-6cf8b1f1`. `../../../../etc/hosts` and symlinks to `/etc/hosts` were copied too. Storage sync then uploads these files to the CDN. One contributor PR can leak CI secrets. | Run `realpath`, then require the result to be inside the allowed roots (default: the content dir). Reject dotfiles. Add an extension allowlist and an explicit `allowOutsideRoot` escape hatch. |
| C4 | **Frontmatter can execute JavaScript** [L2] C, re-verified | `core/src/loaders/matter.ts:12` (`matter(raw)` with default engines) | `---js\n{ title: (globalThis.__pwned='executed','T') }\n---` runs code during the build. Content PRs and git-based CMS input become remote code execution in CI. gray-matter also caches every file's content forever (memory leak in watch/dev), and identical files share one `data` object. | Disable the `js`/`javascript` engines (passing options also disables the cache). Better: split frontmatter yourself and parse it with the `yaml` package that `.yaml` files already use. That also fixes the date-type mismatch between `.md` and `.yaml`. |
| C5 | **Getters cannot load nested, spaced or non-ASCII ids under Node ESM** [L2] C, re-verified | `core/src/codegen.ts:39-45` (`encodeURIComponent(id)` used both as the file name and inside the import specifier), `services/generator.ts:283` | Ids `2024/nested`, `hello world` and `café` fail with `ERR_INVALID_MODULE_SPECIFIER` / `ERR_MODULE_NOT_FOUND`. Every collection with subfolders breaks `getX()` in Node SSR. Bun happens to work. Vite is suspected to fail the same way. | Use a safe basename: an ASCII slug plus a short hash of `locale:id`. Keep the id→file map in the getter. Add an import round-trip test under Node. |
| C6 | **Every config load wipes the host's whole CommonJS `require.cache`** [L2][L4] C, re-verified | `core/src/services/config-loader.ts:118-127` (`jiti.cache` **is** `require.cache` when `moduleCache: true`) | Under bun with Vite 8.3, one Anhur build makes Rolldown fail with `failed to resolve import "anhur/generated"`. CJS dependencies are duplicated, which breaks `instanceof` and singletons, and memory grows on every rebuild. | Give jiti a private cache (`moduleCache: false`, or a fresh instance per load). Never touch `require.cache`. Return the config's dependency list from the loader for watching. |

### 2.2 High

**Codegen and identity**

| # | Finding | Where | Failure / fix |
|---|---|---|---|
| H1 | Duplicate ids are silently accepted, and ids that differ only in case overwrite each other [L2] C | `generator.ts:260-274`, `content-collector.ts:207` | `dup.md` + `dup.mdx` give two rows with the same id. `Case.md` + `case.mdx` collide on macOS and Windows. **Fix:** fail on a duplicate `(source, locale, id)` and compare case-folded file names. |
| H2 | Generated identifiers are not validated, escaped or checked for collisions [L1][L2] C | `config.ts:436-482`, `codegen.ts:250-375`, `generator.ts:57-59, 342, 531, 631, 754` | Singleton `site-settings` emits `export { default as site-settings }`, which is invalid JS. `2024-posts` gives type `2024Post`. `"články"` gives `LNky`. `blog_posts`/`blog-posts`, `post`/`posts`, and a view `featuredPosts` vs a collection `featured-posts` all collide. A singleton named `index` or `locales` overwrites `index.js`. `lookupBy: ["url-slug"]` emits `query.url-slug`. Source names go unescaped into paths, so `../` escapes the output dir. **Fix:** one naming module that computes every export, type and file name, validates each one, keeps a symbol table with reserved names, and uses `JSON.stringify`/bracket access for every interpolated value. |
| H3 | Pluralization is inconsistent [L1] C, re-verified | `config.ts:449-478` | `category` gives `allCategorys`. `news`, `series` and `status` get an extra `s` (`Newss`). `people` gives `allPeoples`, and `data` gives type `Datum`. **Fix:** use `pluralize.plural`, inside the naming module. |
| H4 | Non-JSON values are lost while the `.d.ts` still claims them [L2][L5] C | `generator.ts:38-40` (`JSON.stringify`) | `z.coerce.date()` is a string at runtime but typed `Date`. `Set`/`Map` become `{}`. `BigInt` crashes with a raw TypeError (a defect). **Fix:** reject these values with a typed error that gives the field path, or serialize them with devalue/serialize-javascript and type the result to match. |

**Schema, references, transforms**

| # | Finding | Where | Failure / fix |
|---|---|---|---|
| H5 | `s.reference()` is typed `string` but is an object at runtime [L1] C, re-verified | `schema/reference.ts:54-61` | A user `.transform(d => ``/authors/${d.author}``)` gives `/authors/[object Object]`. `.refine(v => v.length > 2)` always fails. **Fix:** keep the value a string. Mark reference fields with Zod `.meta()` or a registry and resolve them after validation. |
| H6 | Embeds are resolved before transforms but typed after them; skipped documents can still be embedded [L1] C | `relations.ts:108-135`, `builder.ts:152-167`, `config.ts:514-519` | `post.author.upper` typechecks but is `undefined` at runtime. A document dropped by `ctx.skip()` is still embedded. **Fix:** resolve relations after transforms and skips, against the final documents. |
| H7 | Embed cycles and self-references give a different shape depending on content order [L1] C | `relations.ts:109-113, 185-197` | In an A↔B cycle, `A.b.a` is the string `"a1"` but `B.a.b.a` is one level deeper. A self-embed returns a string while the type promises an object. Embeds always go to full depth with no memoization, so size can grow exponentially. **Fix:** resolve against an immutable snapshot, limit the depth (default 1), and reject embed cycles when the config loads. |
| H8 | `s.unique()` slots are not per field [L1] C, re-verified | `schema/unique.ts:42-49` | With `{sku: unique(), code: unique()}`, doc A `code:"x1"` and doc B `sku:"x1"` give a false conflict. Documents that a transform later skips still hold their slot. **Fix:** a constraints pass after transforms, keyed by `(source, fieldPath, scope)`, that reports every conflict. |
| H9 | Transform results are not validated, and the types collapse to `never` [L1] C | `apply-transforms.ts:38-61`, `skip.ts:11-15`, `config.ts:500-519` | `return undefined` gives the error "value is not an Object". A result without `_meta` is accepted and crashes later in codegen. An array is accepted as `{0:…}`. If `TOut` has no `_meta`, every field silently becomes `never`. **Fix:** a transform returns data only, and the engine merges `_meta` back. Check that the result is a plain object. Make `isSkippedSignal` safe for `null`. |
| H10 | Config checks run only inside `defineConfig()`/`define*` [L1] C | `services/config-loader.ts:142-151` | A plain-object config, or hand-built definitions (the repo's own tests do this), skips every check. Checks throw a plain `Error` at import time, and only the first one shows. A view placed in `content`, or a collection in `views`, is silently ignored or mislabeled. **Fix:** the loader always runs `normalizeConfig(raw) → ResolvedConfig | ConfigInvalidError{issues[]}`. |

**Build orchestration**

| # | Finding | Where | Failure / fix |
|---|---|---|---|
| H11 | Concurrent builds corrupt each other [L2][L4] C | `publish-dir.ts:67-69` (fixed `<out>.building` / `.prev` paths) | 4 parallel builds: 3 failed. 24 parallel builds: 16 failed with `ENOENT`/`ENOTEMPTY`. This happens in real use with `vite dev` + `vitest`, `vite dev` + `anhur watch`, or two plugin instances. A build can also publish another build's partial tree. **Fix:** a unique `mkdtemp` staging dir plus a lock file that holds the pid and detects stale locks. |
| H12 | Wrong order of hooks, publish and asset upload [L1][L2][L5] C, re-verified | `builder.ts:203-311` | `onSuccess` runs before integrations and publish, so it fires for builds that then fail. The output is published **before** the CDN upload: if the upload fails, live modules point to missing objects and Vite is not reloaded. Integrations and `complete` get `outputDir = …generated.building`, a path that is renamed away. **Fix:** stage → integrations → upload → publish → `onSuccess`/`complete` (with the real dir) → prune. |
| H13 | Remote prune is destructive by default and runs on every dev keystroke [L2][L4] C | `assets-storage.ts:218, 250-267`; `vite/src/index.ts:132-137` (no `command`/`mode` passed to core) | Preview and production builds that share a prefix delete each other's assets. Rollback is impossible. `vite dev` with storage env vars uploads and prunes the production bucket on every save. Draft documents' images are uploaded publicly, because assets are emitted during validation, before the draft filter. **Fix:** `prune: false` by default, or generation-based GC with a grace period. No sync in dev unless the user opts in. Emit assets only for documents that survive. |
| H14 | Uploaded assets have no Content-Type [L2][L3] C (by code) | `assets-storage.ts:243` | Everything is uploaded as `application/octet-stream`. SVG in `<img>` breaks from the CDN, and PDFs download instead of opening. **Fix:** set the MIME type from the extension, and validate that `base` ends with `prefix/`. |
| H15 | Every error after validation is reported as `ConfigInvalidError`, and only the first error is shown [L1][L2][L5] C | `builder.ts:116-120, 152-165, 177-311` | Publish, storage, prune, hook and integration failures print "Invalid config at …anhur.config.ts" with the cause and stack lost. The first invalid file aborts the build. Reference failures show the first one "and N more". Tagged errors have an empty `.message`, so programmatic users see blank errors. **Fix:** see the error model in §4. |

**Watch and dev**

| # | Finding | Where | Failure / fix |
|---|---|---|---|
| H16 | `anhur watch` is not recursive [L2] C, re-verified in Effect source | `watcher.ts:105, 166-168`; Effect `watchNode` defaults to `recursive: false` | Edits to `content/posts/2024/x.md`, to any localized file (`<locale>/…`) and to `cms/collections/*.ts` never trigger a rebuild. |
| H17 | One defect stops watch mode permanently and silently [L2] C | `watcher.ts:116-142` (`Effect.catch` handles typed failures only) | These all throw plain errors, and the stream fiber dies with no `onError` call: a getter collision, any `views.ts` throw, a user `where`/`select` that throws, BigInt. Later edits never rebuild. **Fix:** `Effect.catchCause`, typed `GenerateFailedError`/`DerivedFailedError`, and `Effect.try` around user callbacks. |
| H18 | Watch has no event filter, so it can loop forever [L2][L4] C | `watcher.ts:166-182`, `vite/src/dev-watch.ts:235-239`, `watch-paths.ts` | With `directory: "."`, one edit gave 24–47 rebuilds and the loop never ends. Once H16 is fixed, the default `.anhur/` will loop too. **Fix:** ignore the output, staging, cache and assets dirs and dotfiles. Rebuild only on paths that match the include globs, the config's dependencies, or asset sources. |
| H19 | Watch roots are computed only once; config imports are not tracked [L2][L4][L5] C | `watcher.ts:144-160`, `watch-paths.ts:31-33` (`cms/` hard-coded) | A new collection, a changed `directory`, `./schemas/*.ts` imports and `.env` never trigger a rebuild. If the config was broken at start, only the config file and `cms/` are ever watched. |
| H20 | Invalid content at startup stops `vite dev` from starting, and the error message is empty [L4][L5] C | `vite/src/index.ts:191-192, 207-208` | `createServer` rejects with a `ValidationFailedError` whose `message` is `""`. `vite build` prints `[anhur] ` with nothing after it. The rejected promise is cached and never retried. **Fix:** format the error. In dev, send it to the overlay and keep watching. In build, call `this.error(formatted)`. |

**Bodies**

| # | Finding | Where | Failure / fix |
|---|---|---|---|
| H21 | Markdown output allows raw HTML and `<script>` (XSS) [L3] C | `markdown/src/compile.ts:39-40` (`allowDangerousHtml` + `rehype-raw`, no sanitizer); the README recommends `dangerouslySetInnerHTML` | `<img onerror>`, `<script>` and `<iframe srcdoc>` pass through unchanged. **Fix:** sanitize by default (rehype-sanitize with the GitHub schema), make raw HTML an explicit opt-in, and block `javascript:`/`vbscript:`/`data:text/html` URLs on purpose. |
| H22 | Every relative link is treated as an asset to copy, including links to other documents [L3] C | `assets/src/remark-copy-linked-files.ts:63-70`, `resolve.ts:12-31`, both `remark-reject-relative.ts` | `[next](./other.md)` publishes the raw markdown source, draft frontmatter included. `./other`, `../guide/#install`, `<Card href="../guide"/>` and `./` all fail the build, some with a raw `EISDIR`. Without `assets()`, any relative link fails the build. **Fix:** classify links by role (image/media vs link). Send content-file links to a `resolveDocumentLink` hook. Pass directory-only and query-only URLs through. |
| H23 | User remark plugins cannot run before the asset pass [L3] C | `{markdown,mdx}/src/body-assets.ts:17,22` | A user plugin cannot rewrite `./x.md` → `/docs/x` before the build fails, so H22 has no workaround. **Fix:** run the asset pass after the user's remark plugins. |
| H24 | MDX `import`, `export … from` and `development: true` compile fine but crash at render [L3] C | `mdx/src/compile.ts:45-48`, `mdx/src/react/index.tsx:30` | `runSync` fails with "Unexpected keyword 'import'" or `_jsxDEV is not a function`. **Fix now:** reject these at build time. **Fix in the rework:** emit real ES modules (see §4). |

**Integrations, packaging, docs**

| # | Finding | Where | Failure / fix |
|---|---|---|---|
| H25 | Orama cannot search non-Latin text [L4] C | `orama/src/client.ts:111-114` (default English tokenizer, one DB for all locales) | Cyrillic `здраво` and Japanese `東京` give 0 hits. **Fix:** one DB per locale, a language/tokenizer map, and per-locale files. |
| H26 | The README quick start returns `null` [L5] C, re-verified | `README.md:43,99`; `generator.ts:86-95` | Without `localization`, `content/posts/en/hello.md` gets the key `default:en/hello`. The suffix fallback looks for `":hello"`, so `getPost("hello")` returns `null`. |
| H27 | `@effect/platform-node` brings a **required** `redis` peer and `undici@8` to every consumer [L5] C | `core/package.json:50-51` | `redis@6.2.1` is installed in this workspace. **Fix:** drop platform-node (see §4.6). |
| H28 | No CI, and the release is fragile [L5] C | no `.github/`; `scripts/release.ts:366-387, 739-753` | Quality gates run only locally. The publish overlay rewrites `package.json` in place, so Ctrl+C during the web-auth wait leaves it modified. Publishing is sequential with no resume and no dist-tag (a prerelease would become `latest`). No git tags and no changelog. **Fix:** GitHub Actions plus changesets, and publish packed tarballs from CI with `--provenance`. |

### 2.3 Medium

**Core config, schema, derived data**

- **Bound helpers lose type narrowing** [L1] C.
  - `createDerivedHelpers` has no type-predicate overloads (`config.ts:1094-1146`).
  - The skill's own `featuredPosts` example loses `featured: true`.
- **`ctx.documents()` depends on order** [L1] C (`transform.ts:25-41`).
  - The first source sees other sources raw, including documents that are later skipped.
  - Later sources see earlier ones transformed.
- **Transform `doc` keeps the phantom embed type** [L1] C (`config.ts:500-503`).
  - `doc.author.name` is error TS2339, and the playground casts around it.
  - `TransformContext.documents` is untyped.
- **View, index and group errors are defects** [L1] C (`views.ts:174-180, 254, 280, 330-344`).
  - The index record is a plain `{}` checked with `in`.
  - Keys `toString`, `constructor` and `__proto__` give a false "duplicate key" or are dropped.
- **Reference lookup gaps** [L1] C (`relations.ts:30-77`).
  - Monolingual → localized references always fail as "ambiguous".
  - A duplicate slug in the same locale silently picks the first match.
  - `by: "slug"` is hard-coded to `data.slug`.
  - Lookup is O(R·N).
- **`s.isodate()` accepts garbage and depends on the time zone** [L1] C.
  - `"1"` → 2000-12-31, `"2024-02-30"` → March 1, and a time with no offset uses the machine's time zone.
  - Builds differ between machines.
- **`s.toc()`** [L1] C.
  - Headings after a skipped level are dropped.
  - An empty body fails (also `s.excerpt()` and `s.metadata()`).
  - The anchors probably do not match the HTML, because neither compiler adds `rehype-slug` (S).
- **`s.slug()` does not slugify** [L1] C.
  - `My Post.md` and unicode file names fail.
  - `from:"path", removeIndex` on `guides/index.md` gives an empty slug.
  - No uniqueness check, although the docs say slugs are unique.
- **`s.metadata()` counts ASCII words only** [L1] C (`metadata.ts:20-23`). Serbian Cyrillic text gives `wordCount: 0`. Use `Intl.Segmenter`.
- **Localized singleton `onSuccess` gets only the first locale** [L1] C (`builder.ts:228-241`).
- **The locale list is barely checked** [L1] C.
  - Duplicates are accepted.
  - Path-like names such as `"../x"` go into `path.join`.
  - A locale named `"default"` collides with the monolingual lookup key.
- **The collector injects the body as an input field `content`** [L1][L2] C (`content-collector.ts:157-161`).
  - It overwrites frontmatter `content`.
  - It breaks `strictObject` schemas.

**Core IO, cache, CLI**

- **Persist-cache fingerprint blind spots** [L2][L3] C (`cache-fingerprint.ts:40-83`).
  - RegExp, Map/Set, bound functions and closure factories fingerprint to the same value.
  - Shared references are reported as `[Circular]`.
  - Compiler and package versions are not in the key, so stale output survives upgrades.
- **The persist cache is never pruned and writes are not atomic** [L2][L3] C.
  - Keys contain absolute paths, so CI starts cold.
  - The cache is **turned off entirely when `assets()` is registered** (`mdx/src/schema.ts:108`, `markdown/src/schema.ts:88`), which is the normal setup.
- **Every rebuild redoes all work, one file at a time** [L2][L5] C.
  - All files are read and validated with concurrency 1 (forced by `s.unique()`).
  - Every module is rewritten and every asset re-copied.
  - The dir swap changes every mtime, so Vite reloads the full page.
  - About 1 s per rebuild at 5,000 documents, before MDX.
- **`fs.glob` matches directories, and a missing root passes silently** [L2] C.
  - `**/*` returns subfolders, which then fail.
  - A typo in `directory` gives an empty collection with no error.
- **Effect usage problems** [L2][L5] C.
  - The layer, including a new jiti instance, is rebuilt on every `build()`.
  - `watch()` closes its layer scope while detached fibers keep running.
  - It uses `forkDetach` with a manual `close()`, and `runPromise` inside effects.
  - `build`/`loadConfig` exist twice (`build.ts`, `cli/host.ts`).
  - Raw `node:fs` is mixed with the Effect FileSystem.
- **CLI** [L2][L5] C.
  - Errors print twice, and defects show a raw stack.
  - The published bin has a `#!/usr/bin/env bun` shebang although `engines` is Node.
- **The two path bases are inconsistent** [L2] C. Content resolves from `rootDir`, while output, cache, assets and `cms/` resolve from `configDir`. The docs say "config file directory".

**Bodies and assets**

- **Image size ignores EXIF orientation**, which causes layout shift on phone portraits [L3] C.
- **The blur placeholder is always reported as 8×8**, whatever its real size [L3] C.
- **URL encoding is broken both ways** [L3] C.
  - `my%20pic.png` is not decoded.
  - The emitted `src` is not encoded (`100%-hash.png`).
  - Files with `#` or `?` in the name cannot be referenced.
- **Body vs field semantics** [L3] C.
  - `md.markdown()` on a missing frontmatter key silently compiles the whole body.
  - `.optional()` never compiles.
  - An empty body fails.
- **SVG and HTML files are served same-origin without sanitizing** [L3] C. This is stored XSS through `[x](./evil.svg)`.
- **HTML attributes are found with a regex** [L3] C (`srcset.ts`).
  - Text and comments trigger copies.
  - Unquoted `src=./x.png` ships broken.
- **MDX JSX inside expressions or `src={"…"}` is not rewritten** [L3] C. The image is broken at runtime.
- **URL schemes use an allowlist** [L3] C. `sms:`, `irc:`, `ftp:`, `blob:` and `javascript:` are treated as file paths.
- **Errors lack the path and document** (sharp, EISDIR) [L3] C. `a.image` copies the file before it validates it, which leaves orphan files.
- **Two emits of the same file at the same time are not combined** [L3] C. The writes into the live assets dir are not atomic.
- **`sharp` is a hard, top-level native dependency** [L3] C. It loads even for `a.file()` or body links. Five sharp copies are installed in the workspace.

**Vite and Orama**

- **State is shared across server restarts** [L4] C. After `server.restart()` with inline plugins, rebuilds stop: the old `close()` disposes the new listener.
- **`syncViteWatchRoots` unwatches paths for all listeners** [L4] C. Vite's own HMR for that dir is lost.
- **`vite build --watch` never rebuilds content** [L4] C. `initialBuild ??=` and no `addWatchFile`.
- **Rebuild errors never reach the browser overlay** [L4] C.
- **The plugin reads the root and config in the `config` hook, not `configResolved`** [L4] C.
  - It runs a full jiti load on `preview` and on vitest.
  - The alias is frozen.
  - The README location for the config is wrong when `root` is set.
- **Orama `index()` return types are not checked against `schema`** [L4] C. Bad values pass the build and crash `createSearcher` in the browser.
- **Orama index format** [L4] C.
  - The `store` JSON is tokenized and searchable.
  - Every row is padded with every field.
  - `collection` and `locale` are `string`, not `enum`.
  - You cannot search locale `en` plus unlocalized collections together.
  - No paging, threshold or boost.
- **No supported way to ship the search index to SSR/production** [L4] S. The playground computes a path from `import.meta.url` that will not exist in `.output`.

### 2.4 Low (grouped)

- **Naming and API surface.**
  - `core/src/index.ts` exports about 200 symbols, including internals and test helpers (`clearIntegrationHandlers`, `pruneEmittedAssets`, codegen helpers).
  - `config.ts` is 1,598 lines.
  - Two "meta" types: `DocumentMeta` vs `ContentMeta`.
  - Dead code: `ValidateDocumentInput`, `DefineView*Input`, `isDerived`, and the markdown reject plugin's JSX branch.
  - A third, unused `remarkRejectRelativeLinkedFiles` in assets.
  - Dozens of `// SAFETY: preserves the existing runtime contract` comments with no content, one of them inside a JSDoc example.
- **Generate options are untyped strings.** `listSort.by`, `lookupBy`, `listOmit`. A typo silently does nothing, and `limit: 1.5` is accepted.
- **Machine-dependent sorting.** `localeCompare` without a locale, and a mixed-type comparator that is not transitive. Output order can differ between machines.
- **Types depend on content data.** `effectiveListOmit` and singleton `| undefined` change with the current content. Large literal unions slow `tsc` down.
- **`.d.ts` config import has no extension.** It breaks under `NodeNext`, and on Windows across drives.
- **Excerpts.**
  - MDX `import` lines and JSX stay in the excerpt.
  - Truncation splits emoji.
  - The output is one character longer than `length`.
- **SVG metadata parser** (`svg-meta.ts`).
  - `stroke-width` matches as `width`.
  - Units are ignored.
  - A commented-out `<svg>` wins.
  - No aspect scaling from `viewBox`.
- **Weak types and parsing.**
  - `a.image()` returns `0×0` for remote or `data:` URLs while the type says real numbers.
  - `parseSrcset` splits on every comma.
- **Short asset hash.** 32-bit hash plus `exists`-skip on upload plus `immutable` cache-control: one collision serves the wrong file forever.
- **Publish window.** Live is briefly missing between the two renames, and there is no crash recovery. Windows `EPERM` is likely (S).
- **Integrations registry.** Global, overwrites silently. `{id: "oram"}` typechecks. `null` entries throw a TypeError.
- **Vite.**
  - The `runner` getter creates an SSR runner as a side effect.
  - The dev asset server has 8 MIME types, no Range, ETag or HEAD handling.
  - `writeBundle` copies assets into the SSR output too.
  - Any id containing `anhur/generated` matches.
  - Events during the initial build are lost.
- **Orama.**
  - `directory: "../.."` writes outside the output dir.
  - Composite ids with `:` collide.
  - A check that can never run.
  - The root entry re-exports the client and pulls `node:fs` into browser bundles.
- **React MDX renderer.**
  - The `MDXComponents` type is too narrow.
  - Nothing is cached, so `new Function` runs on every mount and needs CSP `unsafe-eval`.
  - The `react-dom` peer is unused.
  - The trust model is undocumented: MDX is code and runs on the SSR server.
- **`packageVersion` throws at module load** in bundled consumers.

### 2.5 Tooling and packaging

| # | Sev | Finding | Fix |
|---|---|---|---|
| T1 | Med | `zod` is a regular dependency in core, mdx, markdown and assets, so the user can get two Zod copies. | Make it a peer (or move to Standard Schema). |
| T2 | Med | `@anhur/core` is a regular dependency of vite and orama. The global registry exists to cover the duplicates this causes. | Make it a peer. |
| T3 | Med | The peer `@anhur/assets: "workspace:*"` becomes an **exact** version when published. | Use `^x.y.z`. |
| T4 | Med | Dev `exports` point to `src/*.ts` with extensionless imports, so Node cannot load `@anhur/vite` from the workspace (the playground needs `bun --bun`). There is no `types` condition. | Use a custom `source`/`development` condition and add `types`. |
| T5 | Med | The root override pins `vite` 7.3.6 while the peer range claims `^8`. Vite 8 is never tested, and it is broken under bun (C6). The `@tanstack/start-plugin-core` override is undocumented. | CI matrix over Vite 6, 7 and 8. Document or scope the overrides. |
| T6 | Med | `turbo.json`: `test` tasks have no `dependsOn`/`inputs`, and there is no `globalDependencies` (`tsconfig.base.json`, `tooling/*`). Cached results can go stale (S). | Add them. |
| T7 | Med | `effect` uses the range `^4.0.0-rc.115`, so the next rc can rename APIs (it already happened between beta and rc). The CLI uses `effect/unstable/cli`. | Pin it exactly (or see §4.6). |
| T8 | Low | `packages/vite/tsdown.config.ts.bak` is tracked and stale. | Delete it. |
| T9 | Low | tsdown `devExports` rewrites `package.json` on every build (it added a stray `inlinedDependencies` to assets). | Turn it off and own `exports` by hand, or document it. Turn on `publint`/`attw`. |
| T10 | Low | mdx/markdown use tsdown `platform: "neutral"` but import `node:` builtins (S). | Use `platform: "node"`, or split server and browser entries. |
| T11 | Low | `bellona` is pinned at 0.4.7 in eight places; the user's skill targets 0.5.0. | Keep one pin in `tooling/oxlint`. |
| T12 | Low | `declarationMap`/`sourceMap` maps point to `src/`, which is not shipped. | Drop them, or ship `src`. |
| T13 | Low | `release.ts` uses POSIX `tar`/`find`, a weak semver regex (`1.2.3foo` passes), does not sync `SKILL.md` `metadata.version`, and reads `bun.lock` with a regex. | Replace it with changesets. |
| T14 | Low | `apps/vite-playground/.gitignore:14` has a merged line (`/public/build# Sentry…`). The root `.gitignore` still has a stale "Blume" entry. | Fix both. |
| T15 | Low | No `repository`/`homepage`/`bugs`/`sideEffects` in the manifests. No CHANGELOG and no tags. | Add them. Changesets will produce changelogs. |
| T16 | Low | Six duplicated vitest configs. Some integration projects have no tests, which `--passWithNoTests` hides (orama). | Use a shared base or root `projects`. |
| T17 | Low | 37 vendored third-party agent skills are committed under `.agents/skills`. `npx skills add … ` without `--skill` installs all of them. | Document that this is intentional, or rely on `skills-lock.json` only. |

### 2.6 Where the docs and the code disagree

1. **The `cms/` module tree, enums, objects and `content.ts` are conventions only.** The skill calls them "required", but:
   - there is no `defineEnum`/`defineObject`;
   - the only code awareness is a hard-coded `cms/` watch root;
   - the playground does not follow the "hard rules".
2. **The README quick start returns `null`** (H26). The README also links to a docs reference that was deleted, and its package table leaves out `@anhur/orama`.
3. **`s.unique()` is not "unique across the collection".** It is keyed per (source, group), not per field, and it is per locale by default. `s.slug()` has no uniqueness check, although the docs say it does.
4. **Embeds are not typed as the target document.** The types include transform-added fields, and cycles produce strings.
5. **Bound helpers do not narrow types.** The skill says to always use them, and its own example loses the narrowing.
6. **The described `onSuccess` timing and `outputDir` value are wrong** (H12).
7. **The description of the relative-path base is wrong** (two bases, see §2.3).
8. **The index key does not come from "the pre-select light row".** It comes from the full document.
9. **`getDocumentMeta()` returns a different shape than the one documented.**
10. **`s.isodate()` is not an "ISO date string".** It returns a timestamp that depends on the time zone. The excerpt "max characters" limit is exceeded by one.
11. **The caching promised in the skill and READMEs is turned off whenever `assets()` is used.**
12. **The magic top-level `draft: true` field is not documented.** Any document with it is silently dropped.
13. **The `tsconfig` `paths`/`include` setup for `anhur/generated` is required but not documented.**
14. **The Vite README says it watches "each collection/singleton path".** It does not watch config imports outside `cms/`.

---

## 3. P0: fix before (or in parallel with) the rework

These are small, local fixes for dangerous behaviour. None of them depends on the target architecture.

1. Guard `outputDir` and `assets.dir`. Add an ownership marker and prune only files in the manifest. (C1, C2)
2. Add a realpath containment check to linked/asset file resolution, and reject dotfiles. (C3)
3. Turn off gray-matter's JS engines and its cache, or replace gray-matter with `yaml`. (C4)
4. Use safe document module basenames and add a Node ESM import round-trip test. (C5)
5. Give jiti a private module cache and stop clearing `require.cache`. (C6)
6. Fail on duplicate and case-folded ids, and on invalid or colliding identifiers. (H1–H3)
7. Use a unique staging dir and a build lock. (H11)
8. Fix the order to: upload → publish → `onSuccess`/`complete`. Send `contentType`. Default `prune: false`. No storage sync in dev. (H12–H14)
9. Watch: make it recursive, add an event filter, use `catchCause`, and refresh the roots after each build. (H16–H19)
10. Vite: format errors, keep the dev server alive, and send errors to the overlay. (H20)
11. Markdown: sanitize by default. MDX: reject `import`/`export from`/`development` at build time. (H21, H24)
12. Fix the README quick start. Delete the `.bak` file. Add CI. (H26, T8, H28)

---

## 4. Target architecture

All five lanes reached the same shape independently. Below is the combined proposal.

### 4.1 Package layout

Keep the scoped packages for now, but move the boundaries:

- **`@anhur/core`**:
  - user DSL: `define*`, `schema`, public types;
  - `@anhur/core/build`: the engine, the CLI host and `loadConfig`;
  - `@anhur/core/plugin`: the plugin API;
  - `@anhur/core/internal`: not semver-stable.
  - Assets, CDN storage, srcset and the public-base math move **out** of core.
- **`@anhur/body`** (new, could be internal): the shared Markdown/MDX pipeline. It owns `body()` vs `field()` semantics, plugin ordering, the link classifier and cache replay. `@anhur/markdown` and `@anhur/mdx` become thin adapters of about 30 lines each.
- **`@anhur/assets`**:
  - the asset graph: policy, manifest, metadata, storage sync;
  - the fields `a.image`/`a.file`.
  - `sharp` and `files-sdk` become optional peers loaded lazily.
- **Peers.** `zod` (or `@standard-schema/spec`) and `@anhur/core` are peers everywhere.

An alternative: collapse everything into one package, `anhur`, with subpath exports. This removes six-package lockstep releases and most of `release.ts`. Decide this before P5 (§4.8).

### 4.2 Pipeline stages

Each stage is pure with respect to globals. Each one takes an explicit context and returns typed diagnostics.

```
resolveConfig  → host loads config, returns { config, deps[] }; normalizeConfig → ResolvedConfig
                 (one path base, naming symbol table, reserved names, dir-safety, locale schema)
discover       → files only; detects duplicate / case-folded ids; missing roots are errors
load           → bounded parallel; yaml-based frontmatter (no eval)
validate       → pure Zod; reference fields stay strings, tagged via .meta(); field compilers
                 (mdx/markdown/image) run here and RECORD effects (emitted assets, file deps)
transform      → per-document; returns data, engine re-attaches _meta
join           → cross-source transforms see frozen post-transform snapshots
relations      → Map-indexed, locale fallback rules, depth limit, cycles rejected, ALL failures
constraints    → unique/slug-unique keyed by (source, fieldPath, scope), ALL conflicts
prepare
derive         → views / index / group, wrapped as DerivedFailedError
plan           → in-memory OutputPlan { relPath → bytes, hash } + symbol table; safe serializer
commit         → lock → integrations into unique staging → asset upload → diff-write changed
                 files atomically → manifest → onSuccess/complete (real outputDir) → GC
```

### 4.3 Plugin model (replaces processors, integrations, loaders and both AsyncLocalStorage singletons)

```ts
export interface AnhurPlugin {
  name: string;
  version: string; // part of every cache key
  loaders?: Loader[];
  fields?: Record<string, FieldCompiler>; // matched via zod .meta({ anhur: { kind } })
  transformDocument?(doc: Doc, ctx: PluginCtx): Awaitable<Doc | Skip>;
  setup?(ctx: SetupCtx): void; // declare watch paths, virtual modules + .d.ts fragments
  beforePublish?(plan: PublishPlan, ctx: PluginCtx): Awaitable<void>; // asset upload
  buildEnd?(snap: BuildSnapshot, ctx: PluginCtx): Awaitable<EmitFile[] | void>; // search index
  vite?: VitePlugin;
}

export interface FieldCompiler<I = unknown, O = unknown> {
  compile(input: I, ctx: FieldCtx): Awaitable<O>;
  cacheKey?(input: I, ctx: FieldCtx): string | undefined;
}

export interface FieldCtx {
  file: SourceFile;
  document: { id: string; locale?: string };
  body: string;
  options: unknown;
  emitAsset(path: string, role: "image" | "media" | "link"): AssetRef; // recorded, replayable
  addDependency(path: string): void;
  diagnostics: DiagnosticSink;
  signal: AbortSignal;
  mode: "dev" | "build";
}
```

Integrations become plain objects with closures. No `globalThis` registry, no side-effect registration and no `nativeModules` workaround.

### 4.4 Error model

```ts
type Diagnostic = {
  code: `ANHUR_${string}`;
  severity: "error" | "warning";
  file?: string;
  position?: { line: number; column: number };
  fieldPath?: (string | number)[];
  message: string;
  hint?: string;
  cause?: unknown;
};

interface BuildReport {
  ok: boolean;
  diagnostics: Diagnostic[];
  changedOutputs: string[];
  stats: BuildStats;
}

class AnhurBuildError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {}
}
```

- The engine never throws for content problems. It collects every diagnostic.
- Each hook gets its own code (`ANHUR_HOOK_PREPARE`, …).
- Positions are mapped through the YAML `LineCounter`.
- Every error has a real `.message`.

### 4.5 Cache and incremental model

- **Manifest.** `.anhur/cache/manifest.json` is keyed by `{ anhurVersion, configHash, plugin@version[] }`. It stores, per file, the content hash. Per document it stores the validated-data hash and the compiled-field hashes. It records these dependency edges:
  - reference target → referrers;
  - collection → transform readers;
  - collection → views;
  - file → included files and assets.
- **Field cache.** The value is `{ output, recordedEffects }`. A cache hit replays the asset emits. This removes the hack that turns the cache off when `assets()` is used.
- **Incremental rebuild.** A `FileChange` invalidates that document and its dependents only. Only the affected output modules are re-emitted. Unchanged files are not rewritten (no mtime churn).
- **GC.** Cache entries not touched during a successful build are deleted.

### 4.6 Runtime choice: Effect

Lane 5 recommends removing Effect from the published runtime. Lanes 2 and 4 recommend using it correctly. **Recommendation: keep Effect inside the engine, but:**

- **API.** Expose only a Promise/AsyncIterable API (`createEngine().build() / watch() / close()`).
- **Runtime.** One `ManagedRuntime` per host (Vite plugin instance, CLI process).
- **Scoping.** A scoped watcher (`forkScoped`, finalizers) and `catchCause` at every boundary.
- **IO.** All IO goes through one FileSystem service, which also enables in-memory FS tests.
- **Dependencies.** Replace `@effect/platform-node` with a small Node FS/Path layer (removes the `redis` peer and `undici`). Pin `effect` exactly.

The rework needs typed errors, scopes, interruption and bounded concurrency, which is what Effect gives. The current cost comes from how Effect is used, not from Effect itself.

If the public packages must stay dependency-light, reopen this at P5.

### 4.7 Codegen and adapters

- **Output.**
  - JSON payloads per document, with safe basenames: an ASCII slug plus a hash.
  - A precomputed key index per locale with no suffix scan. A bare string lookup on a localized collection is a type error.
  - Non-JSON values are rejected, or serialized with devalue and typed to match.
  - Keep the `index.d.ts` inferred from the config, which is Anhur's strength. Add an opt-in `types: "emit"` mode.
- **Vite.**
  - Resolve `anhur/generated/*` through `resolveId`/`load` as virtual modules served from the in-memory build. Only `.d.ts` is written to disk.
  - Per-server state in a `WeakMap`.
  - Config loaded through Vite's module runner (which gives the dependency graph) in `configResolved` with `{ command, mode, env }`.
  - Errors go to the overlay. The server never fails to start.
  - Only changed modules are invalidated, plus a custom `anhur:update` event for soft refresh.
  - `build --watch` support with `addWatchFile`.
  - Assets are emitted through `this.emitFile` in the client environment only.
- **Next.** `withAnhur(nextConfig)`, as content-collections does.
- **CLI.** `anhur build | watch | check --reporter=pretty|json`, with a Node shebang.

### 4.8 Bodies, MDX and search

- **Markdown.** Sanitized by default.
- **Assets.** The asset pass runs at the hast stage, which gives real HTML parsing.
- **Links.** Classified by role. Content links resolve through the content graph.
- **MDX.** Emit real ES modules (`outputFormat: "program"`) into `generated/mdx/<doc>.js` and expose lazy components. This gives working imports, no `eval`, CSP safety, tree-shaking and HMR. Keep `runSync` only as an opt-in "remote" mode.
- **Orama.**
  - One DB per locale with a tokenizer/language map.
  - `collection` and `locale` as enums.
  - `store` kept outside the schema.
  - Each collection's schema inferred with a `const` generic, so `index()` is type-checked.
  - The build validates by inserting into Orama.
  - A typed `anhur/generated/search` module with `loadSearcher(locale)` and hashed asset URLs.

### 4.9 Phased migration

| Phase | Content | Exit criterion |
|---|---|---|
| **P0** | §3 safety fixes, CI, changesets, Zod/core as peers | No data loss or code execution path. CI is green on Node and Bun. |
| **P1** | `normalizeConfig` + naming module; diagnostics model; aggregated validation, reference and unique errors; Vite overlay | A config error or content error lists every issue, with file and field path. |
| **P2** | Plugin interface; `.meta()` field kinds; reference fields stay strings; relations after transforms; constraints pass; `processors`/`integrations` mapped to plugins as deprecated adapters; both AsyncLocalStorage singletons and the global registry deleted | There is no `globalThis` state. The H5–H9 type and runtime tests pass. |
| **P3** | `@anhur/body` (shared pipeline, link classifier, cache replay) and the asset graph moved out of core | The markdown/mdx duplication is gone. The cache works with `assets()`. |
| **P4** | Engine with a manifest, dependency graph, `changed` builds, diff writes and a config dependency graph; the hard-coded `cms/` is deleted | Editing one file rebuilds only that file's dependents. No self-trigger. |
| **P5** | Codegen v2 (JSON, key index, serializer, MDX as modules); Vite virtual modules and per-module HMR; Next adapter; Orama redesign; decide on one package vs scoped packages | Per-module HMR. Getters work under Node ESM for any id. |
| **P6** | Remove the deprecated shims, update docs and skill, release 0.1.0 | Docs match the code (the §2.6 list is empty). |

---

## 5. Test coverage to add

Today's suites pass, but they do not cover the risky paths. Add these, mostly as regression tests for the findings above:

- **Safety.**
  - `outputDir`/`assets.dir` pointing at `src`, `.`, content or `public`.
  - Traversal (`../`), absolute paths, symlinks, dotfiles.
  - `---js` frontmatter.
  - Markdown XSS payloads.
  - SVG with a script.
- **Codegen.**
  - Import every generated module under Node ESM, with ids containing `a/b`, spaces, `café`, `%`, `#` and `?`.
  - Duplicate and case-only ids.
  - Invalid or colliding identifiers (`site-settings`, `2024-posts`, `post`/`posts`, `index`, `locales`).
  - `index.js` parses and `index.d.ts` passes `tsc`.
  - Date/Set/Map/BigInt round-trip.
- **Schema.**
  - A reference field under a user `.transform`/`.refine`.
  - An embed of a transform-added field.
  - Cycles and self-embeds.
  - Two `unique()` fields.
  - Transforms returning undefined, null, an array, or an object without `_meta`.
  - Garbage isodate input and time-zone independence.
  - Slug with spaces or unicode.
  - Cyrillic metadata.
  - TOC with a skipped heading level.
  - `strictObject` with a body.
  - Index keys `toString`/`__proto__`.
  - Narrowing with bound helpers.
- **Watch.**
  - Nested and localized edits.
  - A config change that adds a collection.
  - Starting with a broken config.
  - Surviving a defect.
  - No self-trigger.
  - Debounce and coalescing.
  - SIGINT cleanup.
- **Concurrency.** Parallel builds in one process and across processes. Crash between renames. Hook order. `complete` sees the final `outputDir`.
- **Assets.**
  - Content-Type on upload.
  - Draft assets not uploaded.
  - Base/prefix mismatch.
  - Partial upload failure.
  - More than 1000 orphans.
  - EXIF orientation and blur dimensions.
  - URL-encoded paths.
  - Concurrent emits.
- **Cache.**
  - Fingerprint with RegExp, Map, closures and version bumps.
  - Growth and GC.
  - Cache with `assets()`.
- **Vite.**
  - Dev start with invalid content.
  - Overlay payload.
  - Restart (inline and file config).
  - `build --watch`.
  - Multi-environment builds.
  - Two plugin instances.
  - Real SSR invalidation.
  - Vite 6, 7 and 8, under Node and Bun.
- **Orama.**
  - Non-Latin text.
  - Locale filter.
  - `properties: "*"`.
  - Wrong `index()` values must fail the build.
  - Store typing.
  - Size and performance at 2k+ documents.
- **CLI.** Exit codes, one error print, the dist bin under Node.
