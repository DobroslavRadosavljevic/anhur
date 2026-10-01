# `@anhur/assets`

🖼️ Images and files for Anhur content.

Point a schema field at a local image or file next to your Markdown/MDX/YAML/JSON. Anhur copies it into a content-hashed assets folder and gives you a public URL (plus size, type and a blur placeholder for images) in the generated data.

## 📦 Install

```sh
bun add @anhur/assets
```

You also need `@anhur/core` and `zod`. Image metadata uses [sharp](https://sharp.pixelplumbing.com/) (optional peer — install it when you use `a.image()`).

## 🚀 Setup

Register the plugin **and** use `a.image()` / `a.file()` in your schema:

```ts
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { assets, schema as a } from "@anhur/assets";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: s.object({
    title: s.string(),
    cover: a.image(),
    hero: a.image({ allowRemote: true }).optional(),
    attachment: a.file().optional(),
  }),
});

export default defineConfig({
  content: [posts],
  plugins: [assets()],
});
```

```md
---
title: Hello
cover: ./cover.png
attachment: ./spec.pdf
---
```

| Helper                           | Result                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `a.image()`                      | `{ src, width, height, contentType, blurDataURL?, blurWidth?, blurHeight? }` |
| `a.image({ allowRemote: true })` | the above, or `{ src, remote: true }` for `https://…`, `//host/…` or `/…`    |
| `a.image({ blur: false })`       | no blur placeholder                                                          |
| `a.file()`                       | `{ src, size, contentType }`                                                 |

Width and height follow EXIF orientation. SVGs report their size from `width` / `height` / `viewBox` (whole pixels, at least 1). `a.image()` reads AVIF, GIF, JPEG, PNG, SVG, TIFF and WebP; use `a.file()` for other files such as `.ico`.

`allowRemote` keeps only `http(s)://…`, protocol-relative `//host/…` and root `/…` URLs. Other schemes (`javascript:`, `data:`, …) fail the build.

## ⚙️ Options

| Option       | Default                    | What it does                                                         |
| ------------ | -------------------------- | -------------------------------------------------------------------- |
| `dir`        | `.anhur/assets`            | Folder for copies (relative to the config; must not overlap content) |
| `base`       | `/anhur-assets/`           | Public URL prefix; a full URL (CDN) is used as is                    |
| `devBase`    | see storage                | URL prefix used in dev mode                                          |
| `roots`      | the project folder         | Extra folders assets may be read from                                |
| `extensions` | `DEFAULT_ASSET_EXTENSIONS` | Allowed extensions (images, audio, video, captions, fonts, PDF)      |
| `svg`        | `"sanitize"`               | Rebuild SVGs from an allowlist (`"keep"` to copy them as is)         |
| `storage`    | —                          | Upload to object storage (below)                                     |

`base` and `devBase` must be a path prefix (not the site root `/`, no `.` / `..` segments, no `?` / `#`) or an `http(s)` URL. Characters that are not valid in a URL path are percent-encoded (`/my assets/` → `/my%20assets/`).

### Extensions

`DEFAULT_ASSET_EXTENSIONS` covers images, audio, video, `.vtt` captions, fonts and `.pdf`. Data, archive and office formats (`.json`, `.txt`, `.csv`, `.zip`, `.gz`, `.epub`, Word / Excel / PowerPoint) are opt-in, because a stray link such as `../service-account.json` would publish a private file:

```ts
import {
  assets,
  DEFAULT_ASSET_EXTENSIONS,
  DOCUMENT_ASSET_EXTENSIONS,
} from "@anhur/assets";

assets({ extensions: [...DEFAULT_ASSET_EXTENSIONS, ".zip"] });
// or every document format:
assets({
  extensions: [...DEFAULT_ASSET_EXTENSIONS, ...DOCUMENT_ASSET_EXTENSIONS],
});
```

### Roots

Files are read from the project folder (the folder of the config file). Add `roots` for files outside it, or for a package in `node_modules`:

```ts
assets({ roots: ["../shared/images", "node_modules/@fontsource/inter/files"] });
```

Below the matching root, dotfiles, dot-folders and `node_modules` are always refused. A root may itself be a dot-folder (`roots: [".shared"]`).

## 🛡️ Safety

- Files are read only from the project folder (and `roots`), after resolving symlinks. `../../secret`, dotfiles (`.env`) and `node_modules` are refused.
- Only listed extensions are copied; the default list has no data or office formats.
- Copies are named `name-<hash>.ext`, so URLs are cache-safe. Each copy is checked against its hash; a file that changes during the build fails it ("run the build again").
- The plugin only deletes files it created (tracked in `.anhur-assets.json`) and refuses to write into a folder with files it did not create. A folder without that manifest is only adopted when every file has a hashed asset name with an allowed extension.
- Files of earlier builds are deleted only after the new generated modules are written. When a copy fails, the files already copied are still recorded, so the next build removes them.
- Files of any size are hashed, copied and uploaded as streams.
- Do not run `vite build` (or `anhur build`) while a dev server uses the same `dir`: each removes the files the other one does not use. Give one of them its own `dir` if you need both.

### SVG

With `svg: "sanitize"` (default), each SVG is parsed as XML and rebuilt from an allowlist of SVG elements and presentation attributes:

- no `<script>`, `<foreignObject>`, XHTML or other foreign elements, event handlers, comments, processing instructions or `xml:base`;
- `href` / `xlink:href` keep only `#fragment`, relative and `http(s):` URLs (entities and control characters are decoded first), plus raster `data:image/…` URLs on `<image>` / `<feImage>`;
- `<animate>` / `<set>` / `<animateMotion>` / `<animateTransform>` that change links or event handlers are removed;
- SVGs that are not well-formed XML, use custom entities, or are larger than 16 MiB fail the build. Fix the file, or use `svg: "keep"` for it.

The SVG mode is part of the output name, so switching between `"keep"` and `"sanitize"` (or a sanitizer update) copies and uploads the SVGs again under new names.

Sanitizing is defense in depth. Serve assets with these headers in production too (the Vite dev server sends them):

```text
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data: 'self'; sandbox   (for .svg)
```

Better still, serve user-supplied files from a separate origin (a CDN domain).

## 🔗 Body images and links

With `@anhur/mdx` or `@anhur/markdown`, relative URLs in the body — `![Alt](./photo.png)`, `[PDF](./spec.pdf)`, `<video src="./clip.mp4">`, `srcset` — are copied and rewritten when `assets()` is registered. Links to other content files are left alone. Without `assets()`, relative asset URLs fail the build so broken paths do not ship quietly.

## ⚡ With Vite

[`@anhur/vite`](https://www.npmjs.com/package/@anhur/vite) serves the assets folder in dev (with ranges for video, correct content types and the headers above) and copies the files the build uses into the client build output.

## ☁️ Remote storage

Optional upload to any [files-sdk](https://files-sdk.dev/) backend (S3, R2, MinIO, …). `base` must be the public URL of the `prefix`:

```ts
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";

assets({
  base: "https://cdn.example.com/site/",
  storage: {
    prefix: "site",
    files: () => new Files({ adapter: s3({ bucket: "assets" }) }),
  },
});
```

| Storage option | Default                               | What it does                                           |
| -------------- | ------------------------------------- | ------------------------------------------------------ |
| `prefix`       | (required)                            | Key prefix; must match the end of `base`               |
| `files`        | (required)                            | A files-sdk client, or a factory (only called on sync) |
| `prune`        | `false`                               | After a build, delete unused hashed keys (see below)   |
| `pruneEmpty`   | `false`                               | Allow pruning when the build has no assets             |
| `syncInDev`    | `false`                               | Also upload in dev / watch mode (never prunes)         |
| `dryRun`       | `false`                               | Report changes without uploading or deleting           |
| `concurrency`  | `8`                                   | Parallel uploads (a whole number of at least 1)        |
| `cacheControl` | `public, max-age=31536000, immutable` | Sent with uploads, along with the content type         |

Uploads run in **build mode only** by default. In dev, URLs point at the local copies (`devBase` defaults to `/anhur-assets/`), so editing content never touches the bucket. A process remembers the keys it uploaded or found, so rebuilds do not ask the bucket again.

Pruning is off by default because previews and rollbacks may still use older files; turn it on only when one deployment owns the prefix. It runs only in **build** mode (never in dev, even with `syncInDev`), after the generated modules are written, and deletes only keys directly under the prefix whose names look like Anhur output (`site/<name>-<16 hex>.<ext>`). Keys in sub-folders (`site/uploads/…`) and other names are never touched.

`files-sdk` is an optional peer. Do not set a `prefix` on the `Files` client itself — Anhur applies `storage.prefix`.

Local MinIO for development: `docker compose -f docker-compose.minio.yml up` at the Anhur monorepo root (throwaway credentials only).

## License

MIT
