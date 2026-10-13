# `@anhur/core`

❤️ The heart of Anhur.

It reads content files from your repo (Markdown, MDX, YAML, JSON), checks them against Zod schemas you write, and generates typed modules your app can import.

## 📦 Install

```sh
bun add @anhur/core zod
```

This also installs the **`anhur` CLI**. Run it from package scripts or with `bunx anhur` / `npx anhur`.

| Entry                | For                                                             |
| -------------------- | --------------------------------------------------------------- |
| `@anhur/core`        | `anhur.config.ts`: `defineConfig`, collections, views, `schema` |
| `@anhur/core/build`  | Hosts and scripts: `build`, `check`, `watch`, `createAnhur`     |
| `@anhur/core/plugin` | Writing plugins, loaders and custom fields                      |

Optional extras:

- MDX bodies → [`@anhur/mdx`](https://www.npmjs.com/package/@anhur/mdx)
- Markdown → HTML → [`@anhur/markdown`](https://www.npmjs.com/package/@anhur/markdown)
- Images and files (optional CDN sync) → [`@anhur/assets`](https://www.npmjs.com/package/@anhur/assets)
- Full-text search → [`@anhur/orama`](https://www.npmjs.com/package/@anhur/orama)
- Vite integration → [`@anhur/vite`](https://www.npmjs.com/package/@anhur/vite)

## 🚀 Example

```ts
// anhur.config.ts
import {
  defineCollection,
  defineConfig,
  defineSingleton,
  schema as s,
} from "@anhur/core";

const authors = defineCollection({
  name: "authors",
  directory: "content/authors",
  include: "*.yml",
  localized: false,
  schema: s.object({ name: s.string() }),
});

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    publishedAt: s.isodate(),
    author: s.reference("authors", { embed: true }),
    excerpt: s.excerpt({ length: 160 }),
    body: s.raw(),
  }),
  transform: (doc) => ({
    ...doc,
    url: `/${doc._meta.locale}/posts/${doc.slug}`,
  }),
});

const settings = defineSingleton({
  name: "settings",
  directory: "content/settings",
  schema: s.object({ siteName: s.string() }),
});

export default defineConfig({
  localization: {
    strategy: "folder",
    locales: ["en", "de"],
    defaultLocale: "en",
  },
  content: [authors, posts, settings],
});
```

```text
content/
  authors/ada.yml
  posts/en/hello.md      → id "hello", locale "en"
  posts/de/hello.md      → id "hello", locale "de"
  settings/en/index.yml  (localized singleton: one file per locale folder)
  settings/de/index.yml
```

```ts
import {
  allPosts,
  getPost,
  getSettings,
  locales,
  type Post,
} from "anhur/generated";

allPosts.filter((post) => post._meta.locale === "en"); // light list (no body)
const post = await getPost({ locale: "de", slug: "hello" }); // full document or null
post?.author.name; // embedded reference
const settings = await getSettings({ locale: "en" });
```

Point TypeScript at the output: `"paths": { "anhur/generated": ["./.anhur/generated"] }` in `tsconfig.json`. With `@anhur/vite` the import also resolves at runtime; without Vite, add the same alias to your bundler.

## 🧩 Schema helpers

`schema` is Zod (`s.object`, `s.string`, `s.array`, …) plus content fields:

| Helper                         | Value                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `s.raw()`                      | the document body as a string (`""` for YAML/JSON)                                                       |
| `s.slug(opts)`                 | the `slug` from the file, or derived from the id; validated, unique per locale                           |
| `s.unique(opts)`               | a string that must be unique (`scope`: `locale` / `collection` / `project`)                              |
| `s.reference("authors", opts)` | id (or `by: "slug"`) of another document; checked; `embed: true` inlines it                              |
| `s.isodate({ output })`        | ISO date string (`datetime`, UTC, or `date`); strict parsing                                             |
| `s.excerpt({ length })`        | plain-text excerpt of the body                                                                           |
| `s.metadata()`                 | `{ readingTime, wordCount }` of the body (any script)                                                    |
| `s.toc({ maxDepth })`          | heading tree; `markdown()` / `mdx()` build it with the body's pipeline, so anchors match the heading ids |

Content fields also work inside `.optional()`, `.default()`, nested objects and arrays. Plain `z.union` of objects cannot hold content fields (use `z.discriminatedUnion`).

## 🔄 Build pipeline

1. Files are found (`include` / `exclude` globs; hidden files and `node_modules` skipped; ids are NFC-normalized) and parsed (front matter must be YAML).
2. Content fields compile, then Zod validates. **Every** error in every file is reported, with its field path. Schemas must produce plain data (strings, numbers, booleans, arrays, objects, `Date`, `Map`, `Set`) — a `URL` or class instance is reported with its field path.
3. `transform(doc, ctx)` adds or reshapes fields. `ctx.documents(otherSource)` reads another source's validated documents; `return ctx.skip("reason")` drops a document.
4. Documents with **`draft: true`** at the top level of the file are dropped, even when the schema does not declare `draft` (they are still validated). Drafts and skipped documents never cause duplicate-slug errors, and references to them fail.
5. `prepare(sources)` may edit or remove the final documents.
6. References are checked and embedded, uniqueness is checked, views are derived, plugins generate extra modules.
7. Output is written: only changed files (a file edited by hand is rewritten), atomically, with a lock against concurrent builds. Anhur only deletes files it created (tracked in `.anhur-manifest.json`) and refuses to write into a folder it does not own.
8. `onSuccess` hooks and `complete(sources, { projectDir, outputDir })` run.

Builds of one session (`createAnhur`, watch, the Vite plugin) run one at a time. The config file and every relative module it imports (also outside the project folder) are watched; installed packages and path aliases are not.

A failed build writes nothing; the previous output stays. Errors are `AnhurBuildError`s with a list of `diagnostics` (`code`, `message`, `file`, `fieldPath`, `hint`).

## ⚡ Speed

Anhur is built for sites with thousands of files. A build does work only for what changed.

| Situation                                | What Anhur does                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Rebuild in a session (dev server, watch) | One `stat` per file. An unchanged document is not read, compiled, transformed, checked, serialized or written again. |
| New session, files unchanged             | Validated documents come from `.anhur/cache/documents`. Files are not parsed or compiled.                            |
| New session after a config change        | Compiled fields (Markdown, MDX, images) come from `.anhur/cache/fields`. Documents are validated again.              |
| First build                              | Documents are compiled in worker threads (see `workers` below).                                                      |

Numbers for your project: `anhur build --timings` prints the time of each stage (also in `result.timings`).

Rules that make this safe:

- **Documents are frozen.** Data from the schema, a transform or `prepare` cannot be changed later. `transform` gets its own copy; hooks, views and plugins get read-only documents. An unchanged document is the same object in every build of a session, so a plugin can compare by identity.
- **`transform` runs again only when its document changed**, or when a source it read through `ctx.documents()` changed. A transform that reads something else (a file, an environment variable, the network) sets `transformCache: false` on the collection and runs on every build.
- **A file is "unchanged" when its size, times and inode are the same.** A file modified in the last seconds is compared by content instead, so two quick saves are never missed. A fresh checkout (new times, same content) is also compared by content.
- **`workers`** in `defineConfig`: `true` (default) uses up to 6 worker threads when 128 or more documents with compiled fields wait; a number sets the most; `false` turns them off. Each worker loads the config file and the compilers itself, so workers trade memory for time. Use `workers: false` when a custom field or loader fills state in memory that a plugin hook reads.
- **`cacheDir: false`** turns the disk caches off.

## ⚙️ Generated exports

Per collection `posts` (type `Post`):

| Export                          | What                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `allPosts`                      | list; light by default (`generate.listOmit`, default `["body"]`)                                          |
| `getPost(idOrQuery)`            | async, lazy-loads one full document; `null` if missing. Localized: `{ locale, slug }` or `{ locale, id }` |
| `Post`, `Posts`, `PostListItem` | types                                                                                                     |
| `PostId`, `PostSlug`            | literal unions with `generate.emitIds` / `emitSlugs`                                                      |

Also: `locales`, `defaultLocale`, `type Locale`, and per singleton `settings` / `getSettings()` / `settingsAll`.

`generate` options: `split` (`light` default, `full`, `list-only`), `listOmit`, `listSort: { by, order }`, `lookupBy`, and export names (`listName`, `getterName`, `typeName` on the definition).

## 🔭 Views

| Helper        | Emits                     | Best for                        |
| ------------- | ------------------------- | ------------------------------- |
| `defineView`  | `T[]`                     | featured / top-N / merged feeds |
| `defineIndex` | `Record<Key, T>`          | detail lookup by slug/sku       |
| `defineGroup` | `{ key, count, items }[]` | facet / SEO landing pages       |

```ts
import { createDerivedHelpers } from "@anhur/core";

const content = [posts, products] as const;
const { defineView, defineIndex, defineGroup } = createDerivedHelpers(content);

const featured = defineView({
  name: "featuredProducts",
  from: products,
  where: (doc) => doc.featured === true,
  generate: { listSort: { by: "price" }, limit: 12 },
});
const bySku = defineIndex({ name: "productBySku", from: products, key: "sku" });
const byAuthor = defineGroup({
  name: "postsByAuthor",
  from: posts,
  by: (doc) => doc.author.name,
});

export default defineConfig({ content, views: [featured, bySku, byAuthor] });
```

Views run on the final documents (after transforms, references and `prepare`). `createDerivedHelpers(content)` types `doc` with embedded references resolved. Indexes and groups emit literal key unions (`ProductBySkuKey`).

## 🖥️ CLI

```sh
anhur build              # validate and write
anhur check              # validate only, write nothing (CI)
anhur watch              # rebuild on change; errors keep the last good output
anhur build --root site --config content/anhur.config.ts --json
anhur build --timings    # time of each build stage
```

Exit code is `1` on errors; `--json` prints a machine-readable report with diagnostics.

## 🛠️ Programmatic API

```ts
import { build, check, createAnhur, watch } from "@anhur/core/build";

const result = await build({ rootDir: "site", mode: "build" });
result.documentCount;
result.written; // files that changed
result.timings; // [{ stage: "validate", ms: 412 }, …]

const controller = await watch(
  { rootDir: "site" },
  {
    onBuild: (result) => console.log(result.documentCount),
    onError: (error) => console.error(error.message),
  },
);
await controller.close();
```

`createAnhur(options)` keeps a session for repeated builds — what the Vite plugin uses. A session remembers the config, every validated document and what later stages made of it, so a rebuild only does work for changed files. Call `close()` when done.

## 🔌 Plugins

```ts
import { definePlugin } from "@anhur/core/plugin";

const sitemap = definePlugin({
  name: "sitemap",
  generate: (context) => {
    const posts = context.sources.find((source) => source.name === "posts");
    context.emitModule({
      path: "sitemap.js",
      code: `export const sitemapIds = ${JSON.stringify(posts?.documents.map((doc) => doc._meta.id) ?? [])};`,
      exports: ["sitemapIds"], // re-exported from anhur/generated
      dts: "export declare const sitemapIds: readonly string[];",
    });
  },
});
```

Hooks: `setup` (validate options), `loaders` (new file types), `generate` (emit modules), `beforePublish` / `afterPublish` (side effects such as uploads). In a session, `context.sources` holds the same document objects for unchanged documents, so `generate` can skip work for a source whose documents are the same as last time.

Custom fields use `defineField(zodSchema, { kind, compile, cache, pure })` from `@anhur/core/plugin`:

| Option   | Use                                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cache`  | `{ version, key }`: keep the compiled value on disk. `key(context)` covers every option that changes the value.                                                                                             |
| `pure`   | `true` when the value depends only on the input, the body, the document and what the field reports through its context. Documents whose fields all have `pure` or `cache` are restored from disk next time. |
| `shares` | Keys of the values this field computes through `context.share(key, compute)`, so another field of the document can use the same work (`s.toc()` reads the headings of the body `m.body()` compiles).        |

A field without `pure` and `cache` (for example one that calls an API) runs in every new session.

## License

MIT
