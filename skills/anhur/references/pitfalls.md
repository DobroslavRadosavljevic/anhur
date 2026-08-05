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

## Locale folder mismatch

**Symptom:** Missing documents for a locale, or unexpected monolingual merge.

**Fix:** Localized sources need `{directory}/{locale}/…`. Opt out with `localized: false`. `defaultLocale` must be listed in `locales`.

## Sharp / Bun lifecycle

**Symptom:** `@anhur/assets` install fails or sharp missing under Bun.

**Fix:** `bun pm untrusted` → trust `sharp` (and related) via `trustedDependencies` as needed.

## Cache stale after asset URL rewrite

Asset-rewriting builds skip the disk cache for affected compiles. If something looks stale with `cacheDir` enabled and no assets processor, delete `.anhur/cache` or set `cacheDir: false`.

## Draft still appears

**Fix:** Return `ctx.skip(...)` or set `draft: true` in validated data **before** codegen (transform). `prepare` can also remove docs from `sources[].documents`.

## Config not found

**Fix:** Config defaults to `anhur.config.ts` under Vite root / `--root`. Pass `configPath` / `--config` when relocated. All relative paths are from the config file directory.

## Scope rename

If packages are published under a different npm scope than `@anhur/*`, install that scope but keep virtual import `anhur/generated` and `.anhur/` dirs unless the release notes say otherwise.
