# Scopes

A scope is an extra output with only some of the documents. The main output (`outputDir`) keeps every document; each scope writes its own folder. Typical use: a public build without drafts next to a full build for previews and checks.

## Config

```ts
import { defineConfig } from "@anhur/core";
import { content, items } from "./cms/content";

export default defineConfig({
  content,
  scopes: [
    {
      name: "public", // letters, digits, "_" and "-", starting with a letter
      outputDir: ".anhur/public", // relative to the config file
      where: {
        // Keyed by source name; `doc` is that source's document type.
        items: (doc, ctx) => {
          if (!doc.partOf) return doc.status !== "draft";
          const parent = ctx
            .documents(items)
            .find((item) => item._meta.id === doc.partOf);
          return parent?.status !== "draft";
        },
      },
    },
  ],
});
```

- A source with no `where` entry keeps every document.
- `ctx.documents(source)` gives every document of a source after transforms and `prepare`, before any scope picks. `ctx.scope` is the scope name.
- References are still ids in `where` (they resolve after the scope picks). Embedded references are documents only in the output.

## What runs per scope

| Once per build                                    | Again for each scope                              |
| ------------------------------------------------- | ------------------------------------------------- |
| find, load, compile, validate, `transform`, drafts | `where`                                           |
| `prepare`                                         | references (check + embed), uniqueness            |
| plugin `beforePublish` / `afterPublish`           | views, indexes, groups                            |
| `onSuccess`, `complete`                           | plugin `generate` (for example the Orama index)   |
| asset copy and upload                             | planning and writing the output folder            |

Every output is planned before anything is written: a failing scope leaves every output as it was.

## Types

- Each scope writes its own `index.d.ts`. Id, slug and index key unions (`ItemId`, `ItemByTitleKey`) name only the kept documents.
- A filter written as a type predicate narrows the scope's document type, lists and getters:

  ```ts
  where: {
    items: (doc): doc is typeof doc & { status: "published" } =>
      doc.status === "published",
  }
  ```

- A plain boolean filter keeps the full type: correct, only wider. Views, indexes and groups keep the full document type too.
- `GetScopeTypeByName<typeof config, "public", "items">` is the narrowed type; it is `GetTypeByName` when nothing narrows.

## Importing a scope

- Without Vite: import the scope's folder (`./.anhur/public/index.js`), or map it in tsconfig `paths` and package `exports`.
- With `@anhur/vite`: `import { allItems } from "anhur/scopes/public"`. Add `"anhur/scopes/public": ["./.anhur/public"]` to tsconfig `paths`.

## Results

`BuildResult.scopes`: `{ name, outputDir, sources, documentCount, written, removed }[]`, in config order. `BuildResult.written` and `removed` count every output. The CLI prints one line per scope; `--json` has a `scopes` key. Scope work is timed as the `scopes` stage.

## Errors

| Problem                                           | Code               |
| ------------------------------------------------- | ------------------ |
| A kept document points to a dropped one           | `reference-failed`, message starts with `Scope "<name>":` |
| `where` throws or returns something not boolean   | `scope-failed`, with the file |
| A scope drops the default-locale (or only) document of a singleton that is not `optional` | `scope-failed` |
| Duplicate or bad name, missing `outputDir`, `where` not an object, unknown source, a filter that is not a function | `config-invalid` / `naming-invalid` |
| `outputDir` inside or around the main output, the cache, another scope or the content | `path-unsafe` |

## Pitfalls

- Assets are shared: the asset plugin copies the files of every document into its one folder, also those only dropped documents use. A public deploy that ships the assets folder ships them too.
- A scope folder may not be inside a content folder (collections, localized singletons) or overlap the assets folder: `path-unsafe`.
- A removed or moved scope leaves its old folder with the last files written there. Delete it yourself (a CI build should start from a clean `.anhur/`).
- Generated types of a scope are the same as the main output's: a getter for a dropped document returns `null`, a list simply has fewer items.

