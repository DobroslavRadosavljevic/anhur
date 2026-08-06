# Assets storage (CDN / S3-compatible)

Build-time sync of emitted assets to any [files-sdk](https://files-sdk.dev/) backend (S3, R2, MinIO, GCS, …). Authoring stays **local files in git**; the cloud is delivery only.

## When to use

- Production/CI builds should serve images from a CDN
- You want hashed immutable URLs (`cover-a1b2c3d4.png`) on object storage
- Dev should keep serving from disk via Vite (no bucket traffic)

## Config shape (enable gate B)

Always pass `storage`; gate with `enabled`:

```ts
import { Files } from "files-sdk";
import { r2 } from "files-sdk/r2"; // or minio / s3 / …
import { assets } from "@anhur/assets";

const upload = process.env.ANHUR_ASSETS_UPLOAD === "1";

assets({
  dir: ".anhur/assets",
  base: upload ? "https://cdn.example.com/anhur/" : "/anhur-assets/",
  storage: {
    enabled: upload,
    prefix: "anhur",
    prune: true,
    files: () =>
      new Files({
        adapter: r2({
          bucket: "anhur-assets",
          accountId: process.env.R2_ACCOUNT_ID!,
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        }),
      }),
  },
});
```

### Options

| Field          | When `enabled: true`   | Notes                                                                             |
| -------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `enabled`      | required               | `false` → local only; `files`/`prefix` optional                                   |
| `files`        | required               | Prefer a **factory** so disabled builds never construct the client                |
| `prefix`       | required               | Isolates list/delete (e.g. `"anhur"`)                                             |
| `prune`        | default `true`         | Delete remote keys under prefix not emitted this build                            |
| `pruneEmpty`   | default `false`        | If `true`, allow prune when this build emitted **zero** assets (full prefix wipe) |
| `dryRun`       | default `false`        | Plan uploads/deletes without writing                                              |
| `concurrency`  | default `8`            | Parallel uploads                                                                  |
| `cacheControl` | default immutable year | Sent on upload                                                                    |

Install peers for the adapter you use, e.g. MinIO/S3:

```sh
bun add files-sdk @aws-sdk/client-s3 @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
```

`files-sdk` is an **optional peer** of `@anhur/assets`.

## Lifecycle

1. Emit locally (content-hashed copy under `dir`) — always
2. Generated `src` uses `base` (CDN origin when uploading)
3. After successful codegen: upload missing keys → prune orphans (if enabled) → local prune
4. Vite: when `storage.enabled` and `base` is `http(s)`, skip copying assets into the Vite outDir

Build logs include a summary line when sync runs (`uploaded` / `skipped` / `deleted`), plus truncated key lists so you can see exactly which objects changed. The same lines appear in Vite and `anhur build` / `anhur watch`.

## Hard rules for agents

1. Do **not** invent browser/signed upload media libraries — out of scope. This feature is **build-time sync only**.
2. Require non-empty `prefix` when enabled.
3. Prefer `files: () => new Files(…)` factories.
4. Do **not** set a constructor `prefix` on the `Files` instance — Anhur applies `storage.prefix`.
5. Empty emit skips prune unless `pruneEmpty: true` (avoids wiping the CDN).
6. Fail the build on upload errors or bulk-delete partial failures.
7. Document: no concurrent prod builds sharing one prefix (prune race).

## Local MinIO

Repo root: `docker compose -f docker-compose.minio.yml up` (throwaway credentials — local only).

## Guide

User-facing docs: apps docs [Assets](/guides/assets) / package `@anhur/assets` README.
