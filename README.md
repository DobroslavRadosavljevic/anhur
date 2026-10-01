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
| Site search         | Orama index per locale, any script             |
| CDN asset delivery  | Build-time upload to S3/R2/MinIO via files-sdk |

## ⚙️ How it works

1. You describe your content in `anhur.config.ts`
2. You put files in folders (for example `content/posts/`)
3. Anhur validates them and writes modules to `.anhur/generated`
4. Your app imports from `anhur/generated`

```ts
import { allPosts, getPost } from "anhur/generated";

// Light list for index pages (heavy fields like `body` are left out)
allPosts.map((post) => post.title);

// One full document, loaded lazily (null when missing)
const post = await getPost("hello");
// localized collections: await getPost({ locale: "en", slug: "hello" })
```

A build either succeeds completely or changes nothing: every problem (schema errors, broken references, duplicate slugs, unsafe asset paths) is reported with the file and field, and the previous output stays in place.

## 📦 Packages

Install only what you need:

| Package                                  | What it’s for                                                       |
| ---------------------------------------- | ------------------------------------------------------------------- |
| [`@anhur/core`](./packages/core)         | Config, schemas, the build engine, and the `anhur` CLI              |
| [`@anhur/vite`](./packages/vite)         | Vite apps: builds before the app, rebuilds on change, error overlay |
| [`@anhur/mdx`](./packages/mdx)           | MDX body fields + React renderer                                    |
| [`@anhur/markdown`](./packages/markdown) | Markdown → sanitized HTML body fields                               |
| [`@anhur/assets`](./packages/assets)     | Images/files next to content; optional CDN upload (files-sdk)       |
| [`@anhur/orama`](./packages/orama)       | Build-time full-text search with typed hits                         |

## 🚀 Quick start

```sh
bun add @anhur/core @anhur/vite zod
# optional extras:
bun add @anhur/mdx @anhur/markdown @anhur/assets @anhur/orama
```

**1. Config** — `anhur.config.ts`:

```ts
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { markdown, schema as md } from "@anhur/markdown";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    body: md.body(),
  }),
});

export default defineConfig({
  content: [posts],
  plugins: [markdown()],
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

**3. TypeScript** — point `anhur/generated` at the output in `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "paths": { "anhur/generated": ["./.anhur/generated"] },
  },
}
```

Add `.anhur/` to `.gitignore`.

**4. Content** — add `content/posts/hello.md`:

```md
---
title: Hello
---

Your post body goes here.
```

Set `draft: true` in a file's front matter to leave it out of the output (it is still validated; declare `draft: s.boolean().optional()` if you also want it typed).

**5. Use it** — import from `anhur/generated` in your routes or components.

Without Vite, use the **`anhur` CLI** that comes with `@anhur/core`:

```sh
anhur build   # validate and write .anhur/generated
anhur check   # validate only (CI)
anhur watch   # rebuild on change
```

## 📚 Learn more

- Package READMEs under [`packages/`](./packages) for install and usage details
- Example app: [`apps/vite-playground`](./apps/vite-playground) (TanStack Start, every package)
- Agent skill (for coding assistants): [`skills/anhur/`](./skills/anhur/)

```sh
npx skills add DobroslavRadosavljevic/anhur --skill anhur
```

## License

MIT
