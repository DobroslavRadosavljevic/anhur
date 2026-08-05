# Why Anhur

## The job

Keep **content as files** next to the app, and still get **safe, typed access** in TypeScript — without standing up a CMS or writing a one-off Markdown pipeline per project.

Authors edit `content/…`. Developers import generated modules. The build fails early if front matter is wrong, a relation is broken, or an image path is missing.

## Problem it solves

| Pain                                            | Anhur answer                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| “What’s the shape of a post?”                   | Zod schema in `anhur.config.ts`                               |
| “Did we forget `title` on this MDX?”            | Build error at collect time                                      |
| “How do I load all posts in a locale?”          | Folder i18n + generated `allPosts` / getters                     |
| “Post → author without stringly ids everywhere” | `s.reference("authors", { embed?: true })`                       |
| “MDX + images without custom Vite glue”         | Opt-in `@anhur/mdx` + `@anhur/assets` + Vite plugin        |
| “Heavy body on every list item”                 | Default **light** list (omit `body`) + `getPost()` for full docs |

## Why not just…

**Hand-rolled `fs` + gray-matter**  
Fine for one folder and one shape. Breaks down with many collections, i18n, relations, assets, drafts, and shared types.

**A headless CMS**  
Right when editors need a UI, roles, and remote workflows. Extra cost and ops when the team is happy with git + Markdown.

**Only MDX-as-routes**  
Great for pages that _are_ the route. Weaker for querying lists, joining authors, emitting typed catalogs, or sharing the same content outside the router.

## Design bets (so agents don’t invent the wrong product)

1. **Local files first** — no CMS connector in v0
2. **Zod + fail-fast** — missing processor for `m.mdx()` / `a.image()` fails the build
3. **Modular packages** — core stays free of MDX/sharp; opt in with processors
4. **Vite first** — `@anhur/vite`; CLI for CI / non-Vite; Next adapter later
5. **Whole-document i18n** — locale folders, not field-level translation yet

## One-sentence pitch

Anhur is the typed content layer between your repo’s Markdown/YAML/JSON and your app’s imports.
