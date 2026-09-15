# Pitfalls

## Monolithic `anhur.config.ts`

**Symptom:** Config file owns every `defineCollection`, inline enums, and views; hard to review and reuse.

**Fix:** Split into `cms/collections`, `singletons`, `enums`, `objects`, `views`, plus `cms/content.ts`. Keep config as wire-up only. See [project-structure.md](project-structure.md).

## Views from `@anhur/core` instead of helpers

**Symptom:** Embed/reference fields mistyped or not remapped in `where` / `select` when using `createDerivedHelpers` elsewhere.

**Fix:** Import `defineView` / `defineIndex` / `defineGroup` from `cms/views/helpers.ts` (`createDerivedHelpers(content)`).

## Processor missing

**Symptom:** Build error that `m.mdx()` / `md.markdown()` / `a.image()` requires a processor.

**Fix:** Add matching `mdx()`, `markdown()`, or `assets()` to `defineConfig({ processors })`.

## Relative body asset without `assets()`

**Symptom:** Relative `![…](./x.png)` or `<img src="./x.png">` fails the build.

**Fix:** Register `assets({ … })`. Absolute `https://` URLs are fine without it. Relative `srcset` / `srcSet` / `imagesrcset` candidates are copied the same way as `src`.

## Import path wrong

**Symptom:** Cannot resolve `@anhur/generated` or `./.anhur/generated` in app code.

**Fix:** Import **`anhur/generated`** only. Ensure Vite plugin is installed and `tsconfig` paths map that id.

## Generated folder missing in CI

**Symptom:** `tsc` fails on missing modules under `.anhur/generated`.

**Fix:** Run `anhur build` (or Vite build) before typecheck, or commit generated output.

## Wrong document type / getter for plural names

**Symptom:** `use_cases` produced `UseCas` / `getUseCas` on older `@anhur/core` (before pluralize-backed naming).

**Fix:** Upgrade `@anhur/core`. Defaults are `UseCase` / `getUseCase` / `allUseCases`. Set `typeName` on `defineCollection` (not under `generate`) when you need a custom type. Default getter follows `typeName`.

## Stale `allX.js` / `getX.js` after rename or remove

**Symptom:** Old list/getter modules still on disk after deleting a collection (pre-wipe codegen).

**Fix:** Current Anhur clears `outputDir` on every generate. Rebuild once after upgrading; no manual `rm -rf` needed for normal renames.

## Locale folder mismatch

**Symptom:** Missing documents for a locale, or unexpected monolingual merge.

**Fix:** Localized sources need `{directory}/{locale}/…` (e.g. `cms/content/posts/en/…`). Opt out with `localized: false`. `defaultLocale` must be listed in `locales`.

## Wrong locale / null from getter / mixed-locale lists

**Symptom:** `getPost({ slug })` is `null`; detail page shows the wrong language; index page lists every locale; `defineIndex({ key: "slug" })` fails the build; TypeScript rejects `locale: "cz"`.

**Fix:** Pass `{ locale, slug }` with generated `Locale` (`locale` is required on localized getters). Scope lists with `allX.filter((d) => d._meta.locale === locale)`. Import `Locale` / `locales` / `defaultLocale` from `anhur/generated` instead of hand-rolling unions. Do not index bare `slug` when the same slug exists in multiple locales. See [localization.md](localization.md).

## Sharp / Bun lifecycle

**Symptom:** `@anhur/assets` install fails or sharp missing under Bun.

**Fix:** `bun pm untrusted` → trust `sharp` (and related) via `trustedDependencies` as needed.

## Asset storage enabled without CDN `base`

**Symptom:** Build fails: `storage.enabled: true` requires an absolute `http(s)` URL for `base`.

**Fix:** Set `base` to the public CDN origin in prod/CI (e.g. `https://cdn.example.com/anhur/`). Keep `/anhur-assets/` for local with `enabled: false`.

## Asset storage wiped the bucket / unexpected deletes

**Symptom:** Remote objects under the prefix disappeared after a build with few or no assets.

**Fix:** Empty emit skips prune by default. Do not set `pruneEmpty: true` unless you intend a full prefix wipe. Always use a dedicated `prefix`. Do not run concurrent prod builds that share one prefix.

## Asset storage / files-sdk missing peers

**Symptom:** `ERR_MODULE_NOT_FOUND` for `@aws-sdk/client-s3` (or similar) when constructing a MinIO/S3/R2 adapter.

**Fix:** Install `files-sdk` plus the adapter’s optional peers (see [files-sdk adapters](https://files-sdk.dev/) and [assets-storage.md](assets-storage.md)). Prefer a `files: () => new Files(…)` factory so local `enabled: false` builds never load the provider SDK.

## Cache stale after plugin or compile option change

**Symptom:** MDX/Markdown output ignores a new remark/rehype plugin or plugin option while `cacheDir` is enabled and `assets()` is not registered.

**Fix:** Cache keys fingerprint plugin functions and `[plugin, options]` tuples (not just plugin counts). Prefer the tuple form so option changes invalidate. Delete `.anhur/cache` if you still see a stale compile after a factory-style `plugin(options)` call.

## Vite `base` vs asset URLs

**Symptom:** With `base: '/blog/'`, generated image `src` is `/anhur-assets/…` (404) or files were copied to `dist/blog/anhur-assets/`.

**Fix:** `@anhur/vite` joins Vite `base` onto generated asset URLs (`/blog/anhur-assets/…`) and still copies files to `dist/anhur-assets/` (Vite does not put `base` on disk). Set `assets({ base: "https://…" })` when the CDN origin is Anhur’s public URL; that skips the local outDir copy.

## Shared assets outside content folders

**Symptom:** Editing `shared/logo.png` referenced from Markdown does not rebuild.

**Fix:** After a successful build, Anhur watches parent directories of `emitAsset` sources that sit outside collection/singleton roots. The first content save that references the file is enough for Vite to subscribe; CLI watch adds the same extra roots.

## Draft still appears

**Fix:** Return `ctx.skip(...)` or set `draft: true` in validated data **before** codegen (transform). `prepare` can also remove docs from `sources[].documents`.

## Config not found

**Fix:** Config defaults to `anhur.config.ts` under Vite root / `--root`. Pass `configPath` / `--config` when relocated. All relative paths are from the config file directory.

## Scope rename

If packages are published under a different npm scope than `@anhur/*`, install that scope but keep virtual import `anhur/generated` and `.anhur/` dirs unless the release notes say otherwise.

## Orama / integrations typing weak (`doc` is `any`)

**Symptom:** `orama({ collections: { posts: { index: (doc) => … }}})` does not type `doc` from your collections.

**Fix:** Put the factory next to an inline `content` array in a normal `defineConfig` (no generics):

```ts
export default defineConfig({
  content: [posts, pages],
  integrations: [orama({…})],
});
```

Do **not**:

- Pass `content` into `orama(…)`
- Use `defineConfig<typeof content>(…)` (unnecessary now)
- Use `complete: orama(…)` or `{ id: "orama", … }` as the app DX

If you author a custom package and `doc` is still `any`, return `createIntegrationConfigEntry` (deferred resolver) + `NoInfer` on options — see [search.md](search.md).

## Unknown Orama collection / singleton key

**Symptom:** Type error on a key under `collections` (or a singleton name like `settings`).

**Fix:** Only collection names from `content` are allowed. Singletons are not searchable via Orama config.

## Search index missing

**Symptom:** Cannot import / read `.anhur/generated/search/orama.json`.

**Fix:** Ensure `orama({…})` is in `integrations` and a build has run. Confirm `directory` / `filename` if customized.

## Unknown integration id at build

**Symptom:** `@anhur/core: unknown integration "…"`.

**Fix:** Import the package that calls `registerIntegration` (e.g. `import { orama } from "@anhur/orama"`), or use `defineIntegration({ id, onComplete })` for one-offs.

## Duplicate index key

**Symptom:** Build fails because two documents share the same `defineIndex` key (e.g. SKU).

**Fix:** Make the key unique in content (`s.unique()`), or change `key` / filter with `where` so only one row wins.

## Multi-collection view without `select`

**Symptom:** Config/build rejects a `defineView` with `from: [posts, pages]`.

**Fix:** Always provide `select`. Rows are tagged with `collection`.

## Views in `content`

**Symptom:** Type error or unused helpers when putting `defineView` / `defineIndex` / `defineGroup` in `content`.

**Fix:** Register them under `defineConfig({ views: […] })` only.

## String sort on numeric prices

**Symptom:** `"99"` sorts after `"149"` with `listSort: { by: "price" }`.

**Fix:** Use `generate.compare: (a, b) => Number(a.price) - Number(b.price)` (or store numbers in the schema).

## Embed phantom on view callbacks (`doc.provider.slug` fails)

**Symptom:** `by: (doc) => doc.provider.slug` type-errors, or you need `as unknown as { slug: string }` casts. Generated `allProxies` types are fine.

**Fix:** Pass `content` (same array as `defineConfig`) into `defineView` / `defineIndex` / `defineGroup`, or use `createDerivedHelpers(content)`. Generated view exports remap embeds via `GetViewByName` without that step — this is only for config callbacks.

## Embedded `body` still on light list rows

**Symptom (before 0.0.11):** `allProxies[0].body` missing but `allProxies[0].provider.body` still present.

**Fix:** Light lists strip `listOmit` keys (default `body`) from nested embeds too. Use `getX` / full split when you need embedded bodies.
