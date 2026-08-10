# Localization — pick, get, and list the right locale

Anhur’s folder i18n is **whole-document**: one file per locale under `{directory}/{locale}/…`. The generated API already keys documents by locale. Use that API — do **not** invent parallel filters, front-matter `lang` fields, or hand-rolled “pick the right MDX” loaders.

Author layout and `localized: false` opt-out: [project-structure.md](project-structure.md).

## Typed locales (generated)

When `localization` is set, codegen emits:

```ts
import {
  type Locale, // "de" | "en"
  locales, // readonly ["en", "de"] (config order)
  defaultLocale, // "en"
} from "anhur/generated";
```

- `Locale` comes from **config** `locales` (not from which folders happen to exist).
- Localized getters require `locale: Locale`.
- Localized documents type `_meta.locale` as `Locale` (via `GetTypeByName`).
- Monolingual sources (`localized: false`) omit locale from the public type; runtime lookup key is still `"default"`.
- Share `Locale` with the app router / Intlayer — one vocabulary.

No `localization` block → no `Locale` / `locales` / `defaultLocale` exports.

## Mental model

| Export                                         | What it contains                                          | How to pick a locale                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Locale` / `locales` / `defaultLocale`         | Project locale catalog                                    | Import from `anhur/generated`                                                                                  |
| `allPosts` (collection list)                   | **Every** locale’s light rows                             | Filter with `_meta.locale === locale`                                                                          |
| `getPost(…)`                                   | One **full** document                                     | **Required** `{ locale, slug }` or `{ locale, id }`                                                            |
| `settings` (singleton primary)                 | **`defaultLocale` only**                                  | Use as-is for default; else use the getter                                                                     |
| `settingsAll` / `allSettings` (`variantsName`) | All locale variants of the singleton                      | Filter `_meta.locale`, or prefer the getter                                                                    |
| `getSettings({ locale })`                      | One singleton locale                                      | **Required** `{ locale: Locale }`                                                                              |
| Views / groups                                 | All matching docs across locales (unless `where` narrows) | Filter in `where` with `_meta.locale`, or filter the export in the app                                         |
| Indexes (`defineIndex`)                        | Unique keys across **all** locales                        | Do not key on `slug` alone if the same slug exists in `en`/`de` — use a composite key or the collection getter |

Every generated document includes `_meta: { id, locale?, … }`. **`_meta.locale` is the locale** — not a schema field you invent.

Internal monolingual key (when `localized: false`): `"default"`. Folder-i18n docs use real locale codes (`"en"`, `"de"`, …).

## Config reminder

```ts
export default defineConfig({
  localization: {
    strategy: "folder",
    locales: ["en", "de"],
    defaultLocale: "en", // typed as a member of locales
  },
  content,
  // …
});
```

- Localized collection files: `cms/content/posts/en/hello.mdx`, `cms/content/posts/de/hello.mdx`
- Localized singleton: `cms/content/settings/en/index.mdx` (default locale required)
- Monolingual source: `localized: false` → files directly under `directory` / `filePath`

## Detail routes — always pass `locale`

```ts
import { type Locale, getPost } from "anhur/generated";

const locale = params.locale as Locale; // or validate against `locales`
const post = await getPost({ locale, slug: params.slug });
if (!post) throw notFound();

const byId = await getPost({ locale, id: "hello" });
```

### Getter rules (collections)

1. **Localized sources:** the typed API is only `getPost({ locale: Locale; id?/slug? })`. `locale` is **required**. Typos like `"cz"` fail typecheck.
2. **Runtime** still accepts a bare string (`getPost("hello")`) as a first-match escape hatch — do **not** use it in apps; it is ambiguous when slugs repeat across locales.
3. Query object without `locale` at runtime defaults the lookup key to `"default"` and returns `null` on folder-i18n collections.
4. Missing combo → `null` (handle with your router’s not-found path).
5. **Monolingual sources:** `getAuthor("jane")` or `getAuthor({ id?/slug? })` — no `locale` in the typed query.

### Getter rules (singletons)

```ts
import { type Locale, settings, getSettings } from "anhur/generated";

// Primary export = defaultLocale document
settings.title;

// Any locale (including default) — locale required when localized
const de = await getSettings({ locale: "de" satisfies Locale });
```

Default `variantsName` is `{name}All` (e.g. `settingsAll`). Override with `generate.variantsName` (e.g. `"allSettings"`). Prefer `getSettings({ locale })` over filtering the All array in routes.

## Lists for the current locale

`allPosts` is **not** pre-scoped to one locale. Scope it with `_meta.locale`:

```ts
import { type Locale, allPosts } from "anhur/generated";

const locale: Locale = params.locale;
const postsInLocale = allPosts.filter((p) => p._meta.locale === locale);
```

That is the supported app-side pattern. Do **not**:

- Add `locale` / `lang` to the Zod schema and filter that instead of `_meta.locale`
- Re-read `cms/content/**` in the route
- Build a second map of “slug → path” by hand

Optional build-time narrowing with a view (fixed locale or shared filter):

```ts
// cms/views/featured-posts-en.ts
import { posts } from "../collections/posts";
import { defineView } from "./helpers";

export const featuredPostsEn = defineView({
  name: "featuredPostsEn",
  from: posts,
  where: (doc): doc is typeof doc & { featured: true } =>
    doc._meta.locale === "en" && doc.featured === true,
  generate: { limit: 12 },
});
```

For “featured in **whatever locale the request is**”, keep one view (or just `allPosts`) and filter `_meta.locale` in the app — do not generate N views unless you truly need static per-locale exports.

## Indexes and groups

`s.slug()` / `s.unique()` uniqueness is **per locale** (same slug in `en` and `de` is fine).

`defineIndex({ key: "slug" })` requires **global** unique keys — duplicate slugs across locales **fail the build**.

| Need                                      | Use                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| Detail page by slug + locale              | `getPost({ locale, slug })`                                                                 |
| Cross-locale unique business key (SKU, …) | `defineIndex({ key: "sku" })` on a monolingual or globally unique field                     |
| Locale-aware map                          | `key: (doc) => `${doc._meta.locale}:${doc.slug}`then look up` index[`${locale}:${slug}`] `` |
| Facets per locale                         | `defineGroup` + filter groups/items by `_meta.locale` in the app, or `where` in the group   |

## Relations

`s.reference(…)` resolves **same locale first**, then monolingual targets. You do not need custom join logic to “find the German author for the German post.”

## Search (`@anhur/orama`)

Index rows include `locale`. Prefer filtering hits / searcher options by the request locale instead of post-filtering titles yourself. See [search.md](search.md).

## Monolingual sources in a localized project

```ts
export const authors = defineCollection({
  name: "authors",
  directory: "cms/content/authors",
  include: "**/*.{yml,yaml}",
  localized: false,
  schema: s.object({
    name: s.string(),
    slug: s.slug(),
  }),
});
```

- Files: `cms/content/authors/jane.yml` (no `en/` segment)
- List: use `allAuthors` as-is (no `_meta.locale` filter; typed `_meta` has no locale)
- Getter: `getAuthor("jane")` or `getAuthor({ id: "jane" })` — typed API has no `locale` field

## Router wiring (pattern)

Pass the **same** locale codes Anhur uses (`locales` / `Locale`) into getters and list filters:

```ts
import { type Locale, locales, allPosts, getPost } from "anhur/generated";

// e.g. TanStack Router / path `/$locale/posts/$slug`
const locale = params.locale as Locale; // or: locales.includes(params.locale) …
const post = await getPost({ locale, slug: params.slug });
const list = allPosts.filter((p) => p._meta.locale === locale);
```

Prefer importing `Locale` / `locales` from `anhur/generated` for Intlayer / UI i18n — one vocabulary for routes, UI, and content.

## Anti-patterns

| Don’t                                                                  | Do                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------- |
| Hand-roll `type Locale = "en" \| "cs"` beside Anhur                    | `import type { Locale } from "anhur/generated"` |
| `allPosts.filter((p) => p.lang === locale)` with a custom schema field | `p._meta.locale === locale`                     |
| `getPost({ slug })` on a localized collection                          | `getPost({ locale, slug })`                     |
| Rely on `getPost(slug)` when slugs repeat per locale                   | Always pass `locale` (required in `.d.ts`)      |
| `defineIndex({ key: "slug" })` on localized posts                      | Getter, or composite `locale:slug` key          |
| Re-glob `cms/content/posts/${locale}` in the app                       | Import `anhur/generated`                        |
| Treat `settings` as “current request locale”                           | `getSettings({ locale })` for non-default       |
| Invent a second content i18n layout beside folder strategy             | `localization` + `localized: false` per source  |

## Checklist

```
- [ ] localization.locales / defaultLocale match route locale codes
- [ ] App imports Locale / locales / defaultLocale from anhur/generated when i18n is on
- [ ] Author files under {directory}/{locale}/… (or localized: false)
- [ ] Detail loaders use getX({ locale, slug|id }) with typed Locale
- [ ] Locale lists filter allX with _meta.locale (or a view where clause)
- [ ] No defineIndex on bare slug when slugs repeat across locales
- [ ] Singletons: primary export for defaultLocale; getter for others
- [ ] No custom lang field / filesystem re-parse for locale picking
```
