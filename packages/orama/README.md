# `@anhur/orama`

🔍 Full-text search for Anhur collections.

Builds one [Orama](https://orama.com/) index per locale at build time and emits it as generated modules. Search the same index in the browser or on the server, with typed hits, in any language.

## 📦 Install

```sh
bun add @anhur/orama
```

You also need `@anhur/core` and `zod`.

## 🚀 Setup

Add `orama({…})` to `plugins`. Document types for `index` / `store` come from the sibling `content` array — no extra generics:

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
    tags: s.array(s.string()).default([]),
  }),
});

export default defineConfig({
  localization: {
    strategy: "folder",
    locales: ["en", "sr"],
    defaultLocale: "en",
  },
  content: [posts],
  plugins: [
    orama({
      collections: {
        posts: {
          schema: { title: "string", tags: "string[]" },
          index: (doc) => ({ title: doc.title, tags: doc.tags }),
          store: (doc) => ({
            title: doc.title,
            href: `/${doc._meta.locale}/posts/${doc.slug}`,
          }),
        },
      },
    }),
  ],
});
```

| Piece        | Role                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `schema`     | Orama field types (`string`, `number`, `boolean`, `enum`, and `[]`)  |
| `index(doc)` | Values for exactly those fields (checked by TypeScript and at build) |
| `store(doc)` | JSON payload returned with each hit (not searched); types the hits   |

Rules, checked by TypeScript and again at build time (the error names the document and its file):

- Keys of `collections` must be collection names from `content`.
- `index()` returns every `schema` field and no other key. A value may be `undefined`: that field is not indexed for that document (`summary: doc.summary` for an optional field).
- `store()` returns JSON. Keys with `undefined` are left out. `Date`, `BigInt`, `NaN`, `Map`, class instances and functions fail the build — convert them first (`date.toISOString()`).
- Field names cannot contain `.` and cannot be `id`, `collection`, `documentId` or `store`. A field has the same type in every collection.
- Every collection needs at least one `string` or `string[]` field (search only matches text).

## 🔎 Search

The build emits `search.js` next to your other generated modules:

```ts
import { createSearcher } from "@anhur/orama/client";
import { loadSearchIndex, searchLocales } from "anhur/generated";

const searcher = await createSearcher(await loadSearchIndex("sr"));

const result = await searcher.search({
  term: "здраво",
  collection: "posts", // optional, or an array
  limit: 20,
});

for (const hit of result.hits) {
  hit.collection; // "posts"
  hit.documentId; // the document id
  hit.store; // what store() returned, typed per collection
}
```

- `loadSearchIndex(locale)` lazy-loads one locale's index (the default locale when omitted). Bundlers split each locale into its own chunk.
- Monolingual collections (`localized: false`) are in every locale's index.
- Query options: `term`, `collection`, `limit` (default 10), `offset`, `tolerance` (typos), `threshold` (`1` default: any word may match; `0`: every word must match), `boost` (`{ title: 2 }`), `properties`.
- The term is trimmed. An empty term finds nothing (it does not list every document).
- `properties` and `boost` only take the index's string fields (`AnhurSearchField`); another name throws. A boost must be positive; `0` is ignored.

### Typed hits

`anhur/generated` exports `AnhurSearchStores` (hit `store` type per collection, from each collection's `store()` return type; `undefined` values become optional keys) and `AnhurSearchField` (the searchable fields). `Searcher<AnhurSearchStores, AnhurSearchField>` is what `createSearcher(await loadSearchIndex())` returns.

The store types are read from `typeof config`, so the config must keep its `plugins` entries in its type, as `defineConfig()` does. A config typed only as `AnhurConfig` falls back to `JsonObject` per collection.

## 🌍 Languages and tokenizing

Every locale uses a Unicode tokenizer, the same at build and in the browser:

- Words come from `Intl.Segmenter` for the locale, so every script works: Latin, Cyrillic, Greek, Arabic, Hebrew, Indic, Thai, CJK, …
- Matching ignores case and Latin/Greek/Cyrillic accents (`Čaša` = `casa`, `Tiếng` = `tieng`). Only combining accents (U+0300–U+036F) are removed, so Indic vowel signs, viramas and Thai marks stay (`काम` ≠ `कम`).
- Spelling variants match: `don’t` = `don't` = `dont` (apostrophes are dropped), `ß` = `ss`, Turkish dotless `ı` = `i` (`ISTANBUL` in `tr` = `istanbul`), final `ς` = `σ`, full-width `ＡＢＣ` = `abc`.
- Separators between digits are dropped: `1,000` = `1.000` = `1000` (and `3.14` = `314`).
- Chinese, Japanese and Korean text (Han, Hiragana, Katakana, Hangul) is indexed as overlapping two-character pieces, so a word inside a compound matches (`タワー` finds `東京タワー`). This does not depend on how the browser's or Node's ICU splits words, so results are the same everywhere. Thai uses the word splitter only.

Add stemming per locale with `languages` (`run` then finds `running`):

```ts
orama({ collections, languages: { en: "english", de: "german" } });
```

- Keys are locales from `localization`, or `"default"` without localization. An unknown key or language fails the build.
- Languages: arabic, armenian, bulgarian, danish, dutch, english, finnish, french, german, greek, hungarian, indian, indonesian, irish, italian, lithuanian, nepali, norwegian, portuguese, romanian, russian, sanskrit, serbian, spanish, swedish, tamil, turkish, ukrainian (stemmers from [`@orama/stemmers`](https://www.npmjs.com/package/@orama/stemmers)).
- Each stemmer is its own chunk: `createSearcher()` loads only the language of the index it opens.

The tokenizer is stored in the index, so search always uses the same rules as the build. After upgrading `@anhur/orama`, rebuild: `createSearcher()` rejects an index from an older version.

`path` (default `"search"`) changes the generated module name.

## License

MIT
