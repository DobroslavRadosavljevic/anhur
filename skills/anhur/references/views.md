# Views, indexes, and groups

Build-time derived exports registered on `defineConfig({ views: […] })`.
They run **after** transforms and `prepare`, and emit list-only modules (no getters / `documents/`).

## Project placement

- One view / index / group per file under `cms/views/`.
- Bind helpers once:

```ts
// cms/views/helpers.ts
import { createDerivedHelpers } from "@anhur/core";
import { content } from "../content";

export const { defineView, defineGroup, defineIndex } =
  createDerivedHelpers(content);
```

Import `defineView` / `defineIndex` / `defineGroup` from `./helpers` in view modules (not from `@anhur/core`) so embed fields remap in `where` / `select` / `key` / `by`.

Register each export in the thin `anhur.config.ts` `views` array. Do not put views in the `content` tuple.

See [project-structure.md](project-structure.md).

## Helpers

| Helper        | Emits                     | Best for                        |
| ------------- | ------------------------- | ------------------------------- |
| `defineView`  | `T[]`                     | featured / top-N / merged feeds |
| `defineIndex` | `Record<Key, T>`          | detail lookup by slug/sku       |
| `defineGroup` | `{ key, count, items }[]` | facet / SEO landing pages       |

## Shared API

```ts
where?: (doc, ctx) => boolean; // type predicates narrow GetViewByName
select?: (doc, ctx) => Item;   // required for multi-collection views
generate?: {
  listOmit?: string[];
  listSort?: { by: string; order?: "asc" | "desc" };
  compare?: (a, b) => number;  // wins over listSort
  limit?: number;              // views: whole list; groups: per group
};
```

`ctx.documents(collectionOrName)` — same join pattern as collection `transform`.
Pass the **collection object** for a typed array.

`from` takes collection **definitions** (not string names) so types flow.

## defineView

- One collection: filter / map
- Two or more: `select` required; rows tagged with `collection: "posts" | …`
- Default list export: `allFeaturedPosts` from `name` (set `listName` for irregular names like `siteFeed`)

## defineIndex

- Single collection + `key` (string field name or `(doc) => string`)
- String `key` / `by` must be a **string-typed document field** (not booleans)
- Duplicate keys fail the build
- Default export: the `name` (`productBySku`)
- Generated: `ProductBySkuKey` literal union + `Record<ProductBySkuKey, Item>`

## defineGroup

- Single collection + `by` (field or function)
- Emits `{ key, count, items }[]` sorted by `key`
- `limit` applies **per group**
- Keys resolved **before** `select` (so you can group by `category` and still emit a slim card)

## Types

- Item type: `GetViewByName<typeof configuration, "featuredProducts">`
- Name arg constrained to configured `views` names (`DerivedName<typeof config>`)
- `GetViewByName` remaps `embed: true` refs like `GetTypeByName` (so view items match collection list types when shapes match)
- Type-predicate `where` + `select`: `select` sees the narrowed document

### Embed fields in callbacks

Generated exports remap embeds. For `by` / `where` / `select` / `key` that read embeds (`doc.provider.slug`), pass `content` (same tuple as `defineConfig`) or use `createDerivedHelpers(content)`:

```ts
const content = [providers, proxies] as const;
const { defineGroup } = createDerivedHelpers(content);

defineGroup({
  name: "proxiesByProvider",
  from: proxies,
  by: (doc) => doc.provider.slug,
});
```

## Pipeline order

validate → refs → transform → prepare → **resolve views/indexes/groups** → codegen → onSuccess → integrations → complete

## Anti-patterns

- Do not put indexes/groups in `content` — only in `views`
- Multi-collection view without `select` — rejected
- Index key field omitted by `select` — key is taken from the pre-select light row (OK); missing field on the light row fails the build
- Relying on string `listSort` for numeric prices (`"99"` vs `"149"`) — use `compare: (a, b) => Number(a.price) - Number(b.price)`
- Casting embed phantoms with `as unknown as { slug: string }` — pass `content` / use `createDerivedHelpers` instead
- Expecting embedded `body` on light lists — light lists strip `listOmit` keys from embeds too; use a getter for full embeds
- `defineIndex({ key: "slug" })` on localized collections when the same slug exists in multiple locales — build fails; use `getX({ locale, slug })` or a composite key. Locale picking: [localization.md](localization.md)
