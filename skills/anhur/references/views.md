# Views, indexes, and groups

Build-time derived exports registered on `defineConfig({ views: […] })`.
They run **after** transforms and `prepare`, and emit list-only modules (no getters / `documents/`).

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
- Type-predicate `where` + `select`: `select` sees the narrowed document

## Pipeline order

validate → refs → transform → prepare → **resolve views/indexes/groups** → codegen → onSuccess → integrations → complete

## Anti-patterns

- Do not put indexes/groups in `content` — only in `views`
- Multi-collection view without `select` — rejected
- Index key field omitted by `select` — key is taken from the pre-select light row (OK); missing field on the light row fails the build
- Relying on string `listSort` for numeric prices (`"99"` vs `"149"`) — use `compare: (a, b) => Number(a.price) - Number(b.price)`
