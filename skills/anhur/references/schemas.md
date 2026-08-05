# Schemas, generate, hooks

## Core `schema as s`

Re-exports Zod (`s.object`, `s.string`, `s.boolean`, …) plus:

| Helper                                        | Purpose                             |
| --------------------------------------------- | ----------------------------------- |
| `s.raw()`                                     | Uncompiled body / string blob       |
| `s.slug()`                                    | Slug field (lookup-friendly)        |
| `s.unique()`                                  | Unique across collection (e.g. SKU) |
| `s.reference("authors", { embed?: boolean })` | Cross-collection ref                |
| `s.isodate()`                                 | ISO date string                     |
| `s.excerpt({ length? })`                      | Excerpt from body                   |
| `s.metadata()`                                | Document metadata object            |
| `s.toc({ maxDepth? })`                        | Table of contents entries           |

Use Zod `.optional()`, `.transform()`, etc. on these fields.

Inside schema `.transform`, `getDocumentMeta()` from `@anhur/core` yields `_meta`-like info (id, locale, paths).

## Opt-in schema namespaces

| Import                                   | Field                   |
| ---------------------------------------- | ----------------------- |
| `schema as m` from `@anhur/mdx`       | `m.mdx()`               |
| `schema as md` from `@anhur/markdown` | `md.markdown()`         |
| `schema as a` from `@anhur/assets`    | `a.image()`, `a.file()` |

## Collection `generate`

| Option                                 | Default / notes                             |
| -------------------------------------- | ------------------------------------------- |
| `split`                                | `"light"` \| `"full"` \| `"list-only"`      |
| `listOmit`                             | Default `["body"]` for light lists          |
| `listName` / `getterName` / type names | Override export names                       |
| `lookupBy`                             | Extra getter keys (default includes `slug`) |
| `emitIds` / `emitSlugs`                | Union type exports                          |
| `listSort`                             | `{ by, order?: "asc" \| "desc" }`           |

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

## Lifecycle hooks

Order: validate → refs → **transform** (skip/draft) → **prepare** → codegen → source **onSuccess** → **complete**.

- `prepare(sources)` — mutate documents before write
- `onSuccess` on collection/singleton — after that source’s codegen
- `complete` — project-wide after all success hooks

## References

`s.reference("authors", { embed: true })` embeds the related document when possible; without embed, stores the id/key. Referenced collection must be registered in `content`.
