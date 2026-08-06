# Search and integrations

## Processors vs integrations

|                      | Processors                        | Integrations                                              |
| -------------------- | --------------------------------- | --------------------------------------------------------- |
| Config field         | `processors`                      | `integrations`                                            |
| When                 | During validate / field compile   | After codegen + per-source `onSuccess`, before `complete` |
| Examples             | `mdx()`, `markdown()`, `assets()` | `orama({…})`, `defineIntegration({…})`                    |
| Needs schema helper? | Yes (paired)                      | No                                                        |

Do **not** put Orama on `complete` or in `processors`.

## Lifecycle (relevant slice)

1. Transforms / drafts / `prepare`
2. Codegen → `.anhur/generated`
3. Per-source `onSuccess`
4. **`integrations`** (registered runners or `onComplete` on the entry)
5. User `complete` hook

## `orama()` config

```ts
import { orama } from "@anhur/orama";

export default defineConfig({
  content: [posts, pages],
  integrations: [
    orama({
      // optional: directory: "search", filename: "orama.json"
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

### Typing rules

- Plain `defineConfig({ content: […], integrations: [orama({…})] })` is enough — no `defineConfig<typeof content>` and no `const content = […] as const` required for typing
- Do **not** pass `content` into `orama(…)` — `defineConfig` infers the sibling `content` array and types callbacks from it
- Collection keys must be collection names from `content` (singletons rejected)
- `index` / `store` `doc` is the final document (schema + transforms + embedded refs)

How it works for package authors: factories return a small deferred resolver via `createIntegrationConfigEntry`, so TypeScript finishes inferring `content` before it checks `orama` options.

### Per-collection fields

| Field    | Role                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------- |
| `schema` | Orama field types for searchable / filterable columns (`string`, `number`, `boolean`, arrays, `enum`, …) |
| `index`  | Map document → values matching `schema` keys                                                             |
| `store`  | Optional hit payload (not matched by default). Defaults to `{}`                                          |

Base fields added automatically: `collection`, `locale`, `documentId`, `store`. Row `id` is `` `${collection}:${locale}:${documentId}` ``.

### Output

Default path: `{outputDir}/search/orama.json` (usually `.anhur/generated/search/orama.json`).

Snapshot shape (v2): `schema`, `searchProperties`, `collections`, `documents`. Rebuild at runtime with Orama `create` + `insertMultiple` — Anhur does **not** use `@orama/plugin-data-persistence`.

## Querying (browser or server)

```ts
import { createSearcher, type AnhurOramaIndex } from "@anhur/orama/client";

// Vite / bundler JSON import, or fs.readFile + JSON.parse on the server
import snapshot from "../.anhur/generated/search/orama.json";

const searcher = await createSearcher(snapshot as AnhurOramaIndex);

const all = await searcher.search({ term: "hello", limit: 20 });
const postsOnly = await searcher.searchCollection("posts", {
  term: "hello",
  locale: "en", // or "default" for monolingual
});
```

`SearchHit` includes `id`, `score`, `collection`, `locale`, `documentId`, and `store` (parsed JSON).

Same index file works in the browser and on the server.

## Custom integrations

One-off hooks (no package):

```ts
import { defineIntegration } from "@anhur/core";

integrations: [
  defineIntegration({
    id: "my-hook",
    onComplete: async ({ rootDir, outputDir, sources, config }) => {
      // write extra files, notify, etc.
    },
  }),
],
```

Package pattern (like `@anhur/orama`):

```ts
import {
  createIntegrationConfigEntry,
  registerIntegration,
  type AnyContent,
  type IntegrationConfigEntry,
} from "@anhur/core";

registerIntegration({
  id: "my-integration",
  run: async (options, context) => {
    // …
  },
});

export function myIntegration<TContent extends readonly AnyContent[]>(
  options: NoInfer<MyOptions<TContent>>,
): IntegrationConfigEntry<TContent, "my-integration"> {
  return createIntegrationConfigEntry<TContent, "my-integration">(
    "my-integration",
    options,
  );
}
```

Users only write `integrations: [myIntegration({…})]` inside a normal `defineConfig`.

Runtime: `runIntegrations` calls deferred factory entries, prefers a one-off
`onComplete`, and otherwise calls the registered `run(options, context)`.

## Scripts / tests without `defineConfig`

```ts
import { createOramaIntegration } from "@anhur/orama";

const entry = createOramaIntegration({
  collections: {
    /* … */ ,
  },
});
```

Prefer `orama()` inside `defineConfig` for app configs so document types stay tied to `content`.
