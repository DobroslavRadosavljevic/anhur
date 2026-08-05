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

## ⚙️ Options

```ts
anhur({
  // Path to anhur.config.ts if it is not at the project root
  configPath: "./anhur.config.ts",
});
```

## License

MIT
