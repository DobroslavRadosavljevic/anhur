# Pitfalls

## Processor missing

**Symptom:** Build error that `m.mdx()` / `md.markdown()` / `a.image()` requires a processor.

**Fix:** Add matching `mdx()`, `markdown()`, or `assets()` to `defineConfig({ processors })`.

## Relative body asset without `assets()`

**Symptom:** Relative `![…](./x.png)` or `<img src="./x.png">` fails the build.

**Fix:** Register `assets({ … })`. Absolute `https://` URLs are fine without it.

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

**Fix:** Localized sources need `{directory}/{locale}/…`. Opt out with `localized: false`. `defaultLocale` must be listed in `locales`.

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

## Cache stale after asset URL rewrite

Asset-rewriting builds skip the disk cache for affected compiles. If something looks stale with `cacheDir` enabled and no assets processor, delete `.anhur/cache` or set `cacheDir: false`.

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
