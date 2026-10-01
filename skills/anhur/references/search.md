# Search (`@anhur/orama`)

Build-time [Orama](https://orama.com/) full-text search. One index per locale is emitted as generated modules; the same index is searched in the browser or on the server.

## Config

```ts
import { defineConfig } from "@anhur/core";
import { orama } from "@anhur/orama";

export default defineConfig({
  localization: { strategy: "folder", locales: ["en", "sr", "ja"], defaultLocale: "en" },
  content,
  plugins: [
    orama({
      collections: {
        posts: {
          schema: { title: "string", summary: "string", tags: "string[]" },
          index: (doc) => ({ title: doc.title, summary: doc.summary, tags: doc.tags }),
          store: (doc) => ({ title: doc.title, href: doc.url }),
        },
        products: {
          schema: { name: "string", sku: "string" },
          index: (doc) => ({ name: doc.name, sku: doc.sku }),
        },
      },
      // optional: stemming per locale (keys: locales, or "default" without localization)
      languages: { en: "english", sr: "serbian" },
      // optional: generated module name (default "search")
      path: "search",
    }),
  ],
});
```

| Key          | Meaning                                                                               |
| ------------ | ------------------------------------------------------------------------------------- |
| `schema`     | Orama types: `string`, `number`, `boolean`, `enum`, and their `[]` arrays             |
| `index(doc)` | Every schema field and no other key (TypeScript and build); `undefined` = not indexed |
| `store(doc)` | JSON payload returned with hits (not searched), types the hits. Default `{}`          |

- `doc` is the final document type (transform fields, embedded references) — inferred from `content` in the same `defineConfig`. Never pass `content` or generics.
- Keys must be **collection** names (singletons are rejected at typecheck).
- The same field name must have the same type in every collection. `id`, `collection`, `documentId`, `store` are reserved; names cannot contain `.`.
- Every collection needs at least one `string` / `string[]` field.
- `store()` must return JSON: `undefined` keys are dropped; `Date`, `BigInt`, `NaN`, `Map`, class instances fail the build with the document and path (convert first, e.g. `toISOString()`).
- Monolingual collections are added to every locale's index.

## Generated modules

```text
.anhur/generated/search.js         loadSearchIndex(locale?), searchLocales, types AnhurSearchStores, AnhurSearchField
.anhur/generated/search/en.js      one serialized index per locale (lazy-loaded chunk)
```

## Client

```ts
import { createSearcher } from "@anhur/orama/client";
import { loadSearchIndex, type Locale } from "anhur/generated";

const searcher = await createSearcher(await loadSearchIndex(locale));
const { hits, count } = await searcher.search({
  term: "здраво",
  collection: ["posts", "products"], // optional
  limit: 10,
  offset: 0,
  tolerance: 1, // typo tolerance
  boost: { title: 2 },
});

for (const hit of hits) {
  if (hit.collection === "posts") hit.store.href; // store typed per collection
  hit.documentId; // the Anhur document id
}
```

- The term is trimmed; an empty term finds nothing.
- `properties` / `boost` take only the index's string fields (`AnhurSearchField`); others throw. Boosts must be positive (`0` is ignored).
- `threshold`: `1` (default) any word may match, `0` every word must match.
- Store types come from `typeof config`, so keep `defineConfig()` (a config typed as plain `AnhurConfig` falls back to `JsonObject`).

Cache one searcher per locale (e.g. a `Map<Locale, Promise<Searcher<AnhurSearchStores, AnhurSearchField>>>`). On the server, import the same generated module — it is bundled, no file paths to resolve. On a public endpoint, cap the term length.

## Tokenizer

One Unicode tokenizer for every locale, identical at build and in the browser:

- Words from `Intl.Segmenter` (any script). Case and Latin/Greek/Cyrillic accents are ignored (`Čaša` = `casa`); only combining accents (U+0300–U+036F) are removed, so Indic vowel signs and Thai marks stay.
- Variants match: `don’t` = `don't` = `dont`, `ß` = `ss`, dotless `ı` = `i`, final `ς` = `σ`, full-width = ASCII; digit separators are dropped (`1,000` = `1000`, also `3.14` = `314`).
- Han, Hiragana, Katakana and Hangul are indexed as overlapping two-character pieces, so words inside compounds match (`タワー` finds `東京タワー`) the same way in every engine.
- `languages: { en: "english" }` adds a stemmer (28 languages from `@orama/stemmers`: arabic … ukrainian); each stemmer is its own lazy chunk. Keys are locales (or `"default"`); unknown keys or languages fail the build.

The tokenizer is stored in the index; rebuild after upgrading `@anhur/orama` (old indexes are rejected).

## Custom search or post-build modules

Write a plugin instead of hooking `complete`:

```ts
import { definePlugin } from "@anhur/core/plugin";

export const feed = definePlugin({
  name: "feed",
  generate: (context) => {
    const posts = context.sources.find((source) => source.name === "posts");
    context.emitModule({
      path: "feed.js",
      code: `export const feedIds = ${JSON.stringify(posts?.documents.map((doc) => doc._meta.id) ?? [])};`,
      exports: ["feedIds"], // re-exported from anhur/generated
      dts: "export declare const feedIds: readonly string[];", // appended to index.d.ts
    });
  },
});
```

For a typed factory like `orama()` (options checked against `content`), use `defineContentPlugin` with a `NoInfer<TContent>` options parameter — see `packages/orama/src/plugin.ts`.
