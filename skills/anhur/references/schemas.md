# Schemas, generate, hooks

## Core `schema as s`

Re-exports Zod (`s.object`, `s.string`, `s.boolean`, …) plus:

| Helper                                               | Purpose                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `s.raw()`                                            | The document body (or the field's own string); `""` for YAML/JSON                                          |
| `s.slug({ from?, removeIndex?, pattern?, unique? })` | Value from the file, or derived from the id; `^[a-z0-9]+(-[a-z0-9]+)*$` by default; unique per locale      |
| `s.unique({ scope?, group? })`                       | String unique per `locale` (default) / `collection` / `project`                                            |
| `s.reference("authors", { by?, embed? })`            | Id (or `by: "slug"`) of another document; checked after transforms; `embed: true` inlines the final target |
| `s.isodate({ output? })`                             | Strict ISO 8601 (string or YAML `Date`) → UTC `datetime` (default) or `date`                               |
| `s.excerpt({ length? })`                             | Plain-text excerpt of the body (default 260 chars incl. `…`)                                               |
| `s.metadata()`                                       | `{ readingTime, wordCount }` (any script; 230 wpm)                                                         |
| `s.toc({ maxDepth? })`                               | Heading tree; built by `markdown()` / `mdx()` with the same pipeline as the body, so anchors match its ids |

Use Zod `.optional()`, `.default()`, `.transform()`, etc. on these fields; they also work in nested objects, arrays and discriminated unions (not plain `z.union`).

Content fields compile **before** Zod validates. Document info (`id`, `locale`, paths) is on `doc._meta` in `transform`; custom fields get it from their `FieldContext` (`defineField` in `@anhur/core/plugin`).

## Opt-in schema namespaces

| Import                                | Field                                                |
| ------------------------------------- | ---------------------------------------------------- |
| `schema as m` from `@anhur/mdx`       | `m.body()` (document body), `m.mdx()` (string field) |
| `schema as md` from `@anhur/markdown` | `md.body()`, `md.markdown()`                         |
| `schema as a` from `@anhur/assets`    | `a.image()`, `a.file()`                              |

## Collection `generate`

| Option                                 | Default / notes                             |
| -------------------------------------- | ------------------------------------------- |
| `split`                                | `"light"` \| `"full"` \| `"list-only"`      |
| `listOmit`                             | Default `["body"]` for light lists          |
| `listName` / `getterName` / type names | Override export names                       |
| `lookupBy`                             | Extra getter keys (default includes `slug`) |
| `emitIds` / `emitSlugs`                | Union type exports                          |
| `listSort`                             | `{ by, order?: "asc" \| "desc" }`           |

**Document `typeName`:** set on `defineCollection({ typeName })`, not under `generate`. Default getter is `get${typeName}` (so `use_cases` → `UseCase` / `getUseCase` / `allUseCases`). Each generate clears `outputDir` so removed collections do not leave orphan `allX.js` / `getX.js` modules.

**Splits:**

- `light` — list + per-doc modules + getter (typical for MDX posts)
- `full` — everything on the list; no getter/modules
- `list-only` — list only (products catalog, etc.)

## Singleton `generate`

| Option                                       | Notes                                                |
| -------------------------------------------- | ---------------------------------------------------- |
| `exportName` / `getterName` / `variantsName` | Naming                                               |
| `split`                                      | `light` (modules+getter) vs `full` / `list-only`     |
| `emitAll`                                    | Emit all-locales array when localized (default true) |

Localized singleton layout: `{directory}/{locale}/index.md(x)` by default (`include` override). Monolingual: `filePath: "content/about.md"`.

## Transform context

```ts
transform: (doc, ctx) => {
  if (doc.draft === true) return ctx.skip("draft");
  // Pass the collection/singleton definition or its name string:
  const related = ctx.documents(authors); // or ctx.documents("authors")
  return { ...doc, authorCount: related.length };
};
```

- `ctx.documents(source)` — other sources’ documents (definition or `name`)
- `ctx.skip(reason)` — omit from generated output
- Setting `draft: true` also drops the document

Prefer body compile via schema fields, not transform.

## View / index / group `generate`

Shared with derived exports (`defineConfig({ views })`). See [views.md](views.md).

| Option     | Notes                                                      |
| ---------- | ---------------------------------------------------------- |
| `listOmit` | Override inherited light-list omit before `select`         |
| `listSort` | `{ by, order? }`                                           |
| `compare`  | Custom comparator (wins over `listSort`)                   |
| `limit`    | Cap rows after sort (views: whole list; groups: per group) |
| `listName` | Override default `all…` list export (views)                |

## Lifecycle hooks

Order: compile fields + validate → **transform** (`ctx.skip`, `ctx.documents`) → drop drafts / skips → **prepare** → references (check + embed) → uniqueness → **views** → plugin `generate` → write output (plugin `beforePublish` / `afterPublish`) → source **onSuccess** → **complete**.

- `transform(doc, ctx)` — return new fields or `ctx.skip(reason)`; `ctx.documents(source)` is the frozen, validated, pre-transform data of any source
- `prepare(sources)` — mutate final documents before views + write
- `onSuccess(documents)` on a collection/singleton — after the output is written
- `complete(sources, { projectDir, outputDir })` — project-wide, last

A document is a **draft** when its file has a top-level `draft: true` (it works without declaring the field; declare `draft: s.boolean().optional()` to type it). Drafts are validated but never written, never satisfy references and never cause uniqueness conflicts.

## References

`s.reference("authors", { embed: true })` replaces the string with the related document (`{ …fields, _meta }`) after transforms (the target's transform fields included; embed cycles are rejected). TypeScript types follow: `Post["author"]` is the author document shape, not `string`. Without `embed`, the field stays a string id/key. The referenced collection must be registered in `content`.

Every reference written in the file is checked against the final targets, even when a transform renames or drops the field. Embedding (and the generated type) applies where the transform output still has a string at the schema's reference location; a transform that sets a new value there gets it checked too.
