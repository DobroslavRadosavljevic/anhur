# Anhur

**Turn content files in your repo into typed data your app can import.**

Write posts, pages, and settings as Markdown, MDX, YAML, or JSON. Anhur checks each file against a schema you define, then gives you imports like `allPosts` and `getPost("hello")` — with TypeScript types included.

No hosted CMS. No hand-rolled Markdown parsers in every route. Content lives in git next to your code.

## ✨ Why use it?

Most teams either:

- Parse Markdown by hand in each page (easy to get wrong, hard to keep consistent), or
- Put everything in a remote CMS (extra login, network, and preview setup) when files in the repo would be enough

Anhur is for when **authors edit files in the project**, and the app should treat that content as **safe, typed modules**.

Good fits:

| Use                 | Example                                        |
| ------------------- | ---------------------------------------------- |
| Blog or docs        | MDX posts, Markdown pages                      |
| Marketing site      | Localized pages + site settings                |
| Product catalog     | JSON products with images                      |
| Directories / SEO   | Featured lists, SKU maps, category groups      |
| Multi-language site | Same content under `en/` and `de/` folders     |
| CDN asset delivery  | Build-time upload to S3/R2/MinIO via files-sdk |

## ⚙️ How it works

1. You describe your content shapes in `anhur.config.ts`
2. You put files in folders (for example `content/posts/`)
3. Anhur builds them into `.anhur/generated`
4. Your app imports from `anhur/generated`

```ts
import { allPosts, getPost } from "anhur/generated";

// Light list for index pages (heavy fields like body are skipped by default)
const posts = allPosts;

// Full document when you need it (string id/slug or query object; null if missing)
const post = await getPost("hello");
// or: await getPost({ locale: "en", slug: "hello" })
```

Need a **featured subset**, a **SKU → card map**, or **category groups** without runtime `.filter()`? Use `defineView` / `defineIndex` / `defineGroup` in config — see [`@anhur/core`](./packages/core) and the docs reference for `defineView`.

## 📦 Packages

Install only what you need:

| Package                                  | What it’s for                                                 |
| ---------------------------------------- | ------------------------------------------------------------- |
| [`@anhur/core`](./packages/core)         | Config, schemas, and the `anhur` CLI — always start here      |
| [`@anhur/vite`](./packages/vite)         | Vite apps: rebuild on change + `anhur/generated`              |
| [`@anhur/mdx`](./packages/mdx)           | MDX body fields + React renderer                              |
| [`@anhur/markdown`](./packages/markdown) | Markdown → HTML body fields                                   |
| [`@anhur/assets`](./packages/assets)     | Images/files next to content; optional CDN upload (files-sdk) |

## 🚀 Quick start

```sh
bun add @anhur/core @anhur/vite
# optional extras:
bun add @anhur/mdx @anhur/markdown @anhur/assets
```

**1. Config** — `anhur.config.ts`:

```ts
import { defineCollection, defineConfig, schema as s } from "@anhur/core";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.{md,mdx}",
  schema: s.object({
    title: s.string(),
  }),
});

export default defineConfig({
  content: [posts],
});
```

**2. Vite plugin** — `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import anhur from "@anhur/vite";

export default defineConfig({
  plugins: [anhur()],
});
```

**3. Content** — add a file like `content/posts/en/hello.md`:

```md
---
title: Hello
---

Your post body goes here.
```

**4. Use it** — import from `anhur/generated` in your routes or components.

Without Vite, use the **`anhur` CLI** that comes with `@anhur/core`:

```sh
anhur build
anhur watch
```

## 📚 Learn more

- Package READMEs under [`packages/`](./packages) for install and usage details
- Agent skill (for coding assistants): [`skills/anhur/`](./skills/anhur/)

```sh
npx skills add DobroslavRadosavljevic/anhur --skill anhur
```

## License

MIT
