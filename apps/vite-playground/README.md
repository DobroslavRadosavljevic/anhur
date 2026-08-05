# Anhur Vite playground

TanStack Start + Vite app for developing `@anhur/*` packages.

Workspace packages are **just-in-time** (`exports` → `src`). Vite compiles them directly — no `tsdown` watch / prebuild.

```sh
bun install   # from repo root
bun run dev   # from repo root (turbo → this app) or from this directory
```

`bun --bun` runs Vite so Bun can load TypeScript from `@anhur/vite` and friends when resolving `vite.config.ts`.

Home route imports `allPosts`, `settings`, and `allSettings` from `anhur/generated`. Posts use `m.mdx()`; settings use `s.raw()`.
