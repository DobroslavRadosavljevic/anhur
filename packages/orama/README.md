# `@anhur/orama`

🔍 Full-text search for Anhur collections.

Builds an Orama index at Anhur build time, then lets you search the same snapshot in the browser or on the server.

## 📦 Install

```sh
bun add @anhur/orama
```

You also need `@anhur/core`.

## 🚀 Setup

Put `orama({…})` in `integrations` (not `processors`). Plain `defineConfig` is enough — document types for `index` / `store` come from the sibling `content` array.

```ts
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { orama } from "@anhur/orama";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    summary: s.string().optional(),
  }),
});

export default defineConfig({
  content: [posts],
  integrations: [
    orama({
      collections: {
        posts: {
          schema: {
            title: "string",
            summary: "string",
          },
          index: (doc) => ({
            title: doc.title,
            summary: doc.summary ?? "",
          }),
          store: (doc) => ({
            title: doc.title,
            slug: doc.slug,
            href: `/posts/${doc.slug}`,
          }),
        },
      },
    }),
  ],
});
```

After `anhur build` (or a Vite build with `@anhur/vite`), the index is at:

`.anhur/generated/search/orama.json`

Override with `directory` / `filename` on `orama({…})` if needed.

## 🔎 Query

Same client works in the browser and in Node:

```ts
import {
  createSearcher,
  type AnhurOramaIndex,
} from "@anhur/orama/client";

import snapshot from "../.anhur/generated/search/orama.json";

const searcher = await createSearcher(snapshot as AnhurOramaIndex);

const result = await searcher.search({
  term: "hello",
  collection: "posts", // optional
  locale: "en", // optional; use "default" for monolingual
  limit: 20,
});

for (const hit of result.hits) {
  console.log(hit.store, hit.score);
}
```

`searchCollection(name, query)` scopes to one collection. On the server you can also `fs.readFile` the JSON instead of importing it.

## ✨ What you get

| Piece | Role |
| --- | --- |
| `schema` | Orama field types for matchable columns |
| `index(doc)` | Values written for those columns |
| `store(doc)` | Payload returned on each hit (not matched by default) |

- Collection keys must be collection names from `content` (singletons are rejected at typecheck)
- Full-text only — no vector / AI search in this package
- Index format is a portable v2 snapshot (`create` + `insertMultiple`); no persistence plugin required

## 💡 Tips

- Prefer `integrations: [orama({…})]` — do not put Orama on `complete` or in `processors`
- Do not pass `content` into `orama(…)` and do not need `defineConfig<typeof content>`
- For scripts/tests without `defineConfig`, use `createOramaIntegration({…})`

## License

MIT
