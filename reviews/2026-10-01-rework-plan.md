# Anhur rework — design decisions and work log

Source of truth for the rework on branch `rework/architecture`. Findings refer to
`reviews/2026-10-01-full-review.md` (C*, H*, M*, T* ids).

## Decisions

1. **Keep six scoped packages.** No new published package. The shared body pipeline lives
   in `@anhur/core/plugin`.
2. **Entry points of `@anhur/core`:**
   - `.` — user DSL (`define*`, `schema`), public types, `AnhurBuildError`. No engine code.
   - `./build` — engine: `build`, `watch`, `createAnhur` (session), `loadProject`, CLI host.
   - `./plugin` — plugin authoring: `definePlugin`, `defineField`, `defineLoader`, field
     context types, link/asset helpers, `rehypeLinkedAssets`.
3. **No ambient global state.** Both AsyncLocalStorage singletons and the integration
   registry are deleted.
   - Field helpers are Zod schemas marked through Zod 4 `.meta({ anhur })`. The meta lives in
     the global Zod registry and survives clones and wrappers.
   - The engine walks the schema on the input side, compiles the marked fields with an
     explicit `FieldContext`, then runs Zod on the compiled input. Types stay sound: user
     schema-level transforms see compiled values.
   - `s.reference()` and `s.unique()` are markers. The value stays a string. Relations and
     constraints are separate passes after transforms.
4. **One `plugins` array replaces `processors` and `integrations`.** Typed factories
   (`orama()`) use the deferred-generic entry trick for contextual content typing. There are
   no legacy shims (pre-1.0).
5. **Pipeline:**
   ```
   resolve → discover → load → compile+validate → transform (frozen ctx.documents
   = validated pre-transform snapshots) → drop drafts/skips → relations (after transforms,
   embed graph must be acyclic, depth resolved once per doc) → constraints (unique/slug) →
   prepare → derive → plan (in-memory output files) → commit (lock → plugin
   beforePublish (asset copy/upload) → diff-write → manifest → afterPublish
   → onSuccess/complete)
   ```
6. **Errors.** Every stage collects `Diagnostic`s (code, file, fieldPath, message, hint).
   A build fails with `AnhurBuildError { diagnostics }`. The message is always formatted.
   Watch and Vite never die on a defect (`catchCause`).
7. **Output.**
   - Diff-written files with a manifest (`.anhur-manifest.json`). The manifest is also the
     ownership marker.
   - Per-file atomic writes (tmp + rename).
   - A cross-process lock file and an in-process mutex.
   - Safe module basenames (ASCII slug + hash).
   - A JS-literal serializer (Date/Map/Set/BigInt/undefined round-trip, `__proto__` safe).
   - Getters use exact key lookup (no suffix scan).
8. **Assets.** Core owns resolution policy and records:
   - realpath containment (default: the config dir);
   - dotfile rejection;
   - URL classification by role;
   - safe hashed names (64-bit hash);
   - URL encoding.

   Emits are recorded per document and committed only for surviving documents. The
   `@anhur/assets` plugin owns:
   - the copy into the dir, with manifest-only prune and dir-safety checks;
   - storage sync (before publish, build mode only by default, `prune` default false,
     contentType);
   - the image/file fields, with sharp lazy-loaded, EXIF orientation and real blur size.

9. **Bodies.**
   - Markdown is sanitized by default, and heading ids come from rehype-slug (they match
     `s.toc()`).
   - The linked-asset pass is a rehype-stage plugin. It runs after user remark plugins and
     parses real HTML.
   - MDX keeps function-body output (loader-serializable). It rejects `import`/`export
from`/dev mode at build time, and the renderer caches components by code.
   - `md.body()` / `m.body()` read the body, and `md.markdown()` / `m.mdx()` read a field.
10. **Caching.**
    - In-session: per-file content hash → reuse the validated doc + recorded effects.
    - On disk: a field cache keyed by kind + plugin version + options fingerprint + input.
      It is GC'd after each successful build and works with assets (effects replay).
11. **Paths.** Every relative path in config resolves from the config file directory.
12. **Vite.**
    - The session is created in `configResolved`. `resolveId` handles `anhur/generated`
      (no alias).
    - Per-server state; the dev server survives errors (overlay), and diff-written files
      drive Vite's own HMR.
    - Client-only asset copy, `build --watch` support, mode passed to core.
13. **Orama.**
    - Per-locale indexes with a language/tokenizer option.
    - Enum `collection`/`locale`, `store` outside the schema, and build-time insert
      validation.
    - Emitted as a generated `search` module with `loadSearchIndex(locale)`.
14. **Effect.** Stays inside the engine.
    - Drop `@effect/platform-node` (it requires a redis peer) for
      `@effect/platform-node-shared`.
    - Pin `effect` exactly.
    - One `ManagedRuntime` per session.
15. **Packaging and tooling.**
    - zod and `@anhur/core` become peers.
    - Node shebang and CI workflow.
    - Remove the `.bak` file, fix the `.gitignore` files, and update the docs/skill.

16. **Lint: bellona 0.5.0, every rule of the used plugins enabled.** This shapes the code:
    - Each `Context.Service` sits in its own `*.service.ts` file.
    - `Effect.fn` names inside a service use the `Service.method` form.
    - Layers are built inline (no `make` factories).
    - Exported `Effect.fn` needs an `Effect.fn.Return<…>` annotation.
    - No `forkDetach`.
    - No module-level mutable state in Effect files.
    - Tests use `it.effect` or the Promise API, never `Effect.run*` / `ManagedRuntime`.
    - Every `tryPromise` in a service file gets a timeout.
    - Module names say what the module owns: no `utils` / `helpers`.
    - `JSON.parse` results are decoded or typed `unknown`.

## Progress

- [x] bellona 0.5.0: removed rule ids dropped, all new rules enabled

- [x] core rewrite (engine services, resolver, codegen, CLI, watch)
- [x] markdown / mdx
- [x] assets
- [x] orama (per-locale indexes, unicode tokenizer, schema inference)
- [x] vite
- [x] playground (vite build + dev verified)
- [x] tests: 65 unit + 33 integration across 6 packages (core, markdown, mdx, assets, orama, vite)
- [x] docs / skill / READMEs (README examples typechecked against the real API)
- [x] tooling: CI workflow (Node 22.18 + 24), turbo transit node + globalDependencies, release gates for `./build` / `./plugin` / dist bin, peers published as `^version`

Found while writing tests and fixed:

- `@anhur/vite`: dev session never closed on `server.close()` (now closed in `closeBundle` in dev mode)
- `@anhur/vite`: asset copy skipped everything when the assets folder itself is a dotfolder

## Second review round (subagents)

Five reviewers (engine; schema/types; Markdown/MDX/links; assets/Vite; Orama/tooling/docs) reported ~75 findings, most confirmed with repros. Fixed in five lanes with strict file ownership, each with regression tests:

- Engine: watch recovers when the first build fails; edits during the first build are picked up; per-source document cache (stale-source and overlapping-source bugs); cache GC only deletes its own files; case-only renames; serialized session builds; config imports outside the project tracked; symlinked event paths; plain-data checks with field paths (no more `structuredClone` crashes); cached warnings replayed; codec round-trips (-0, `__proto__`, tag key); NFC ids; atomic lock + heartbeat; orphan-safe manifest; hand-edited outputs rewritten; `prepare` runs before reference/unique checks; drafts detected without a schema field; safe source names; collision-proof `index.d.ts`; `--json` on stdout; ambiguous getter warnings.
- Schema/types: discriminated unions (types, uniques, variant-aware references), pipes/preprocess/codec/catchall, recursive schemas, defaults on missing containers, transform-renamed references, opaque embeds in plain view helpers, slug transliteration, ISO date edge cases, YAML merge keys, front-matter rules, fingerprint (array collisions!), deep data, frozen Map/Set/Date.
- Markdown/MDX: TOC built from the real pipeline (anchors always match), parsed MDX text, sanitize before asset resolution, footnotes, media in the default schema, cache keys with versions + config fingerprint, `documentLink` with suffix/target, component props, page links, dynamic `import()` / top-level `await` rejected.
- Assets/Vite: XML-parsed SVG allowlist sanitizer, re-sanitize on mode change, safe prune (build-only, after publish, hashed direct children), `allowRemote` schemes, narrowed default extensions, `node_modules` refused, macOS case, `server.restart()`, partial-copy safety, streaming hashes/copies/uploads, dev headers (nosniff, SVG CSP), Range/ETag edge cases.
- Orama/tooling: stemmers for 28 languages, script-safe folding, bounded caches, CJK bigrams, spelling variants, typed hit stores, exact `index()`, query validation; CI generates before typecheck; release script publishes from a staged copy, resumes, tags prereleases, ships no broken source maps; root files checked in CI.

Verification: clean-checkout run of every CI step passes (check:root, format, lint, check-types 14/14, 142 unit + 89 integration tests, release verify); playground production build and dev-server smoke test (TOC anchors match, drafts 404).
