# Assets storage (CDN / S3-compatible)

Build-time upload of copied assets to any [files-sdk](https://files-sdk.dev/) backend (S3, R2, MinIO, GCS, …). Authoring stays **local files in git**; the bucket is delivery only.

## When to use

- Production builds should serve images from a CDN
- Hashed, immutable URLs (`cover-1a2b3c4d5e6f7a8b.png`) on object storage
- Dev keeps serving local copies through Vite (no bucket traffic)

## Config

```ts
import { Files } from "files-sdk";
import { r2 } from "files-sdk/r2"; // or minio / s3 / …
import { assets } from "@anhur/assets";

assets({
  base: "https://cdn.example.com/site/", // public URL of the prefix
  storage: {
    prefix: "site",
    files: () => new Files({ adapter: r2({ bucket: "assets" /* … */ }) }),
  },
});
```

- `base` must be an absolute URL ending with `/<prefix>/` — setup fails otherwise.
- `files` may be a client or a factory; the factory is only called when a sync runs, so builds that never upload never load provider SDKs.
- Do not set a `prefix` on the `Files` client — Anhur applies `storage.prefix`.

## When uploads happen

| Mode                         | URLs in generated data       | Upload |
| ---------------------------- | ---------------------------- | ------ |
| `vite build` / `anhur build` | `base` (CDN)                 | yes    |
| `vite dev` / `anhur watch`   | `devBase` (`/anhur-assets/`) | no     |
| dev with `syncInDev: true`   | `base`                       | yes    |

Files are copied locally first (`dir`, default `.anhur/assets`), then keys missing in the bucket are uploaded with their content type and `Cache-Control: public, max-age=31536000, immutable`. Existing keys are skipped (names are content-hashed).

To build without uploading (e.g. local production builds), gate the whole `storage` option on an env var:

```ts
const upload = process.env.ANHUR_ASSETS_UPLOAD === "1";
assets({
  base: upload ? "https://cdn.example.com/site/" : "/anhur-assets/",
  storage: upload ? { prefix: "site", files: () => new Files({ … }) } : undefined,
});
```

## Pruning

Off by default — previews and rollbacks may still reference older files.

| Option       | Effect                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------- |
| `prune`      | Delete unused Anhur assets: only direct children of the prefix with hashed names (batches of 1000) |
| `pruneEmpty` | Allow pruning when the build has no assets                                                         |
| `dryRun`     | Log what would be uploaded / deleted without changing anything                                     |

Pruning runs only in build mode (never in dev, even with `syncInDev`) and only after the generated output was published, so a build that fails later never removes files the live site uses. Keys in sub-folders (`site/preview/…`) and files with other names (`site/uploads/photo.jpg`) are never touched. Still, only enable `prune` when one deployment owns the prefix.

## Drafts

Assets are only collected from documents that end up in the output: drafts and skipped documents never upload their images.

## Local MinIO

`docker compose -f docker-compose.minio.yml up` at the Anhur repo root (throwaway credentials), then the playground with `ANHUR_ASSETS_UPLOAD=1`.

## Peers

Install `files-sdk` plus the adapter's own peers (e.g. `@aws-sdk/client-s3` for S3/MinIO/R2). `ERR_MODULE_NOT_FOUND` for an SDK means a missing adapter peer.
