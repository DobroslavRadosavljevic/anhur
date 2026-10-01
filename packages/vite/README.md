# `@anhur/vite`

⚡ Vite plugin for Anhur.

It builds your content before the app, makes `anhur/generated` importable, rebuilds when content changes, shows build errors in the browser overlay, and serves copied assets.

## 📦 Install

```sh
bun add @anhur/core @anhur/vite
```

## 🚀 Setup

```ts
import { defineConfig } from "vite";
import anhur from "@anhur/vite";

export default defineConfig({
  plugins: [anhur()],
});
```

Put `anhur.config.ts` in the Vite root (or pass `configPath`), and point TypeScript at the output:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "paths": { "anhur/generated": ["./.anhur/generated"] },
  },
}
```

```ts
import { allPosts, getPost } from "anhur/generated";
```

No separate `anhur build` step is needed — the plugin builds on `vite dev` and `vite build` (including `vite build --watch`).

## 🔁 Dev

- Uses Vite's file watcher. Changes to content folders, the config, and files the config imports trigger a rebuild (debounced); unrelated files do not.
- Only changed generated modules are rewritten, so Vite's normal HMR picks them up.
- A failed build keeps the dev server running: the error (with file and field) shows in the overlay and the terminal, and the last good output stays in place. Fixing the file reloads the page.
- Changes made while the first build runs are picked up by a rebuild right after it.
- `server.restart()` keeps rebuilding, also with an inline plugin instance.
- Copied assets are served under their URL prefix, with single `Range` requests (video seeking), `ETag` / `If-None-Match`, correct content types and `X-Content-Type-Options: nosniff`. SVGs also get `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data: 'self'; sandbox`; send the same headers from your production server or CDN. Dotfiles and paths outside the assets folder are never served.

Each build logs one line:

```text
[anhur] rebuilt 12 document(s) in 48ms → .anhur/generated (2 written, 0 removed; posts 8, authors 4)
```

## 📦 Build

A failed content build fails `vite build` with the diagnostics. The assets of this build (the files listed in `.anhur-assets.json`, never leftovers of earlier builds) are added to the client output (for example `dist/anhur-assets/`) when they are served locally; with a CDN `base` and storage, `@anhur/assets` uploads them instead. When the assets base equals the Vite `base`, the files go to the root of the output.

With `vite build --watch`, a content edit runs one content build; the Rollup rebuild caused by the rewritten generated modules reuses it.

Do not run `vite build` while `vite dev` uses the same assets folder: both remove files the other one does not use.

## ⚙️ Options

```ts
anhur({
  // Config file relative to the Vite root. Default: anhur.config.{ts,mts,js,mjs}
  configPath: "./content/anhur.config.ts",
});
```

The Vite `base` is applied to local asset URLs (`base: "/app/"` → `/app/anhur-assets/…`).

Without Vite, use the `anhur` CLI from `@anhur/core` (`anhur build`, `anhur check`, `anhur watch`).

## License

MIT
