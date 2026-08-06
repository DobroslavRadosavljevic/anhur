# Anhur Vite playground

TanStack Start + Vite app for developing `@anhur/*` packages.

Workspace packages are **just-in-time** (`exports` → `src`). Vite compiles them directly — no `tsdown` watch / prebuild.

```sh
bun install   # from repo root
bun run dev   # from repo root (turbo → this app) or from this directory
```

`bun --bun` runs Vite so Bun can load TypeScript from `@anhur/vite` and friends when resolving `vite.config.ts`.

Home route imports `allPosts`, `settings`, and `allSettings` from `anhur/generated`. Posts use `m.mdx()`; settings use `s.raw()`.

## Assets → MinIO (optional)

Local authoring always uses disk + `/anhur-assets/`. To exercise build-time CDN sync against the repo MinIO compose stack:

```sh
# from repo root
docker compose -f docker-compose.minio.yml up -d

# from this app (or with ANHUR_ASSETS_UPLOAD=1 bun run build)
bun run build:assets
```

Defaults match compose: endpoint `http://127.0.0.1:9000`, bucket `anhur-assets`, user/password `anhur` / `anhursecret`, prefix `playground`. Override with `MINIO_ENDPOINT`, `MINIO_BUCKET`, `MINIO_ACCESS_KEY_ID`, `MINIO_SECRET_ACCESS_KEY`.

Console: http://127.0.0.1:9001 — public object URLs look like
`http://127.0.0.1:9000/anhur-assets/playground/<file>-<hash>.ext`.
