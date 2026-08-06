# `@anhur/vite`

⚡ Vite plugin for Anhur.

It rebuilds your content when files change, makes `anhur/generated` importable, and can serve copied assets from `.anhur/assets`.

## 📦 Install

```sh
bun add @anhur/core @anhur/vite
```

## 🚀 Setup

Add the plugin to Vite:

```ts
import { defineConfig } from "vite";
import anhur from "@anhur/vite";

export default defineConfig({
  plugins: [anhur()],
});
```

Put `anhur.config.ts` next to your Vite config (or pass `configPath` to the plugin).

## ✨ What happens in `vite dev` / `vite build`

1. Anhur reads your content config
2. It writes typed modules under `.anhur/generated`
3. You import them as `anhur/generated`

```ts
import { allPosts, getPost } from "anhur/generated";
```

No separate `anhur build` step is required for day-to-day Vite work — the plugin handles it.

### Dev rebuilds

In `vite dev`, Anhur uses **Vite’s file watcher** (not a second watcher):

1. Subscribes to `anhur.config.ts` and each collection/singleton path
2. On change / add / unlink → rebuild (debounced)
3. Invalidates `anhur/generated` modules and triggers a **full page reload**

On startup and each rebuild, Vite logs a short summary, for example:

```text
[anhur] built 12 document(s) → .anhur/generated
[anhur]   posts (4): en/hello, en/world, de/hello, de/world
[anhur]   authors (2): ada, grace
```

After a content or config change you’ll see the same shape with `rebuilt` instead of `built`.

Editing content or the Anhur config both go through that path. Unrelated files outside those roots do not trigger an Anhur rebuild.

(`anhur watch` on the CLI still uses Anhur’s own watcher — there is no Vite server there.)

## ⚙️ Options

```ts
anhur({
  // Path to anhur.config.ts if it is not at the project root
  configPath: "./anhur.config.ts",
});
```

## License

MIT
