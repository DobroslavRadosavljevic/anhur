# `@anhur/core`

❤️ The heart of Anhur.

It reads content files from your repo (Markdown, MDX, YAML, JSON), checks them against schemas you write, and generates typed modules your app can import.

## 📦 Install

```sh
bun add @anhur/core
```

This also installs the **`anhur` CLI** (`anhur build`, `anhur watch`). After install you can run it from your project scripts or via `bunx anhur` / `npx anhur`.

## ✨ What you get

- `defineConfig` / `defineCollection` / `defineSingleton` — describe your content
- `schema` helpers — fields like strings, dates, unique slugs, and references
- `anhur` CLI — included with this package; no separate install

Optional extras live in other packages:

- MDX bodies → [`@anhur/mdx`](https://www.npmjs.com/package/@anhur/mdx)
- Markdown → HTML → [`@anhur/markdown`](https://www.npmjs.com/package/@anhur/markdown)
- Images and files → [`@anhur/assets`](https://www.npmjs.com/package/@anhur/assets)
- Full-text search → [`@anhur/orama`](https://www.npmjs.com/package/@anhur/orama)
- Vite integration → [`@anhur/vite`](https://www.npmjs.com/package/@anhur/vite)

## 🚀 Quick example

`anhur.config.ts`:

```ts
import { defineCollection, defineConfig, schema as s } from "@anhur/core";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.{md,mdx}",
  schema: s.object({
    title: s.string(),
    slug: s.unique(),
  }),
});

export default defineConfig({
  content: [posts],
});
```

Build:

```sh
anhur build
```

Then import the generated data (with `@anhur/vite`, the import path is `anhur/generated`):

```ts
import { allPosts, getPost } from "anhur/generated";
```

## 💡 Tips

- Put one collection (or singleton) per content type — posts, authors, settings, and so on
- Plural folder names are fine: `use_cases` → `UseCase`, `getUseCase`, `allUseCases`. Set `typeName` on `defineCollection` when you need a different document type (not under `generate`)
- Use folders like `content/posts/en/` and `content/posts/de/` when you need multiple languages
- List pages can use the light list (`allPosts`); detail pages can load one full document with `getPost("slug")` or `getPost({ slug })` (returns `null` if missing)
- Each build clears the generate output folder, so renamed or removed collections do not leave stale modules

## License

MIT
