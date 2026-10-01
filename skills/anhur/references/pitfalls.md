# Pitfalls

Every build error is a diagnostic: `code`, `message`, `file`, `fieldPath`, `hint`. Read the hint first. Codes below are the `code` values.

## Missing plugin (`config-invalid`)

**Symptom:** `m.body()` / `md.body()` / `a.image()` reports that it needs a plugin.

**Fix:** Add `mdx()`, `markdown()` or `assets()` to `defineConfig({ plugins })`. There are no `processors` / `integrations` options any more — everything is a plugin.

## Old API names

| Old                                          | Now                                                      |
| -------------------------------------------- | -------------------------------------------------------- |
| `processors: [...]`, `integrations: [...]`   | `plugins: [...]`                                         |
| `m.mdx()` for the body                       | `m.body()` (`m.mdx()` is for string fields)              |
| `md.markdown()` for the body                 | `md.body()`                                              |
| `MDXContent`                                 | `MdxContent` (`@anhur/mdx/react`)                        |
| `search/orama.json` + `createSearcher(json)` | `createSearcher(await loadSearchIndex(locale))`          |
| `storage.enabled`                            | uploads run in build mode; gate `storage` itself         |
| `getDocumentMeta()` (AsyncLocalStorage)      | `transform(doc)` → `doc._meta`, or `defineField` context |
| `defineIntegration`                          | `definePlugin({ generate })`                             |
| `build` / `watch` from `@anhur/core`         | `@anhur/core/build`                                      |

## Relative asset without `assets()`

**Symptom:** `./x.png` in a field or body fails the build.

**Fix:** Register `assets()`. Absolute `https://` URLs need `a.image({ allowRemote: true })` in fields; in bodies they pass through.

## Asset refused (`asset-failed`)

**Symptom:** "outside the folders assets may be read from", "dotfile", "node_modules", or "does not allow".

**Fix:**

- Keep files inside the project folder, or add `assets({ roots: ["../shared"] })`. Dotfiles are never copied; `node_modules` only through an explicit `roots` entry.
- Default extensions are media, fonts and `.pdf`. Data and documents (`.json`, `.txt`, `.csv`, `.zip`, office files) are opt-in so authors cannot publish `package.json` or a key file by linking it: `assets({ extensions: [...DEFAULT_ASSET_EXTENSIONS, ...DOCUMENT_ASSET_EXTENSIONS] })`, or list only what you need.
- `a.image()` reads only formats sharp can decode (no `.ico` / `.bmp`); use `a.file()` for those.

## Remote URL refused

`a.image({ allowRemote: true })` / `a.file({ allowRemote: true })` accept only `https://`, `http://`, `//host/…` and `/path` values. `javascript:`, `data:` and other schemes fail the build.

## SVG refused or changed

With `svg: "sanitize"` (default) SVGs are parsed as XML and rebuilt from an allowlist: scripts, event handlers, `foreignObject`, foreign namespaces and non-http(s) links are removed, and an SVG that does not parse fails the build. Serve SVGs with `X-Content-Type-Options: nosniff` and a restrictive CSP (see the assets README).

## Link to another document treated as broken

Links to pages (`./intro.md`, `../guide/`, `./other.html`, extensionless or version-like paths such as `./release-1.0`) are **not** assets and stay as written. Map them with `documentLink` on `markdown()` / `mdx()`: it gets `{ url, path, suffix, target, document }` (`target` is the project-relative path) and Anhur appends `suffix` (`?query#hash`) to what you return. MDX component props are only treated as files when they start with `./` or `../`.

## Import path wrong

**Symptom:** Cannot resolve `anhur/generated`.

**Fix:** Import `anhur/generated` only (not `./.anhur/generated`). Vite: `plugins: [anhur()]`. TypeScript: `"paths": { "anhur/generated": ["./.anhur/generated"] }`. Other bundlers: alias the id to `.anhur/generated/index.js`.

## Generated folder missing in CI

**Fix:** Run `anhur build` (or `vite build`) before `tsc`. `anhur check` validates but writes nothing.

## Output folder refused (`output-unsafe`)

**Symptom:** Anhur will not write into `outputDir`.

**Fix:** The folder has files Anhur did not create (no `.anhur-manifest.json`). Point `outputDir` at a dedicated folder, or empty it. Anhur never deletes files it did not write.

## Build locked (`output-locked`)

**Symptom:** Another build is writing the same output.

**Fix:** Stop the other process (two `vite dev` servers, or `anhur watch` + `vite dev` on one project). Stale locks from crashed processes are cleared automatically.

## Duplicate id (`duplicate-id`)

`hello.md` and `hello.mdx` (or `Hello.md` + `hello.md`) in one folder map to the same id. Keep one.

## Duplicate slug / unique value (`unique-conflict`)

`s.slug()` is unique per locale by default. Drafts and skipped documents never conflict. Change the value, or `s.slug({ unique: false })`. Unique values are typed: `1` and `"1"` are different.

## Slug cannot be derived

Derived slugs transliterate to ASCII (`Straße` → `strasse`, `Đorđe` → `djordje`, `Здраво` → `zdravo`, Greek too). Names with letters that have no ASCII spelling (Chinese, Japanese, Arabic, …) fail with a message: set `slug` in the file. With `removeIndex`, the root `index` file gets `"index"` (or `""` when your `pattern` allows an empty slug).

## Reference failed (`reference-failed`)

**Symptom:** "no document … in locale "de"".

**Fix:** References resolve in the referrer's locale — add the target in that locale, or make the target `localized: false`. A reference to a draft or skipped document fails too.

## Embed cycle

`posts.related → posts` with `embed: true` both ways is rejected. Embed in one direction and keep the other as a plain reference.

## Front matter not parsed

Only YAML front matter is supported: the first line must be exactly `---` (or `---yaml`). `---js` / TOML front matter and duplicate keys are errors; YAML merge keys (`<<: *defaults`) work. `----` is never front matter, and a leading `---` without a closing line is a thematic break — unless `key: value` lines follow it, then it is an "unclosed front matter" error.

## Locale folder mismatch

Localized sources need `{directory}/{locale}/…`. Files directly under `directory` (or in unknown locale folders) produce warnings and are ignored. Use `localized: false` for monolingual sources. `defaultLocale` must be in `locales`.

## Wrong locale / null from getter / mixed-locale lists

Pass `{ locale, slug }` with the generated `Locale`. Scope lists with `_meta.locale`. Do not index a bare `slug` across locales. See [localization.md](localization.md).

## Draft still appears

`draft: true` must be a top-level **boolean** in the file (the string `"true"` does not count). It works even when the schema does not declare `draft`; declare `draft: s.boolean().optional()` to type it. Or `return ctx.skip("reason")` from `transform`.

## Transform reading other files

`ctx.documents(source)` gives validated, pre-transform, frozen documents of another source. Reading files with `fs` inside `transform` is not tracked for rebuilds; use a custom field with `context.addDependency(path)` instead.

## Plain union with content fields

`s.union([s.object({ cover: a.image() }), …])` is rejected — the walker cannot tell which branch holds the field. Use `s.discriminatedUnion("type", [...])`; references and uniques are then checked only in the variant a document selects.

## Field helper in an unsupported place

Config errors: field helpers inside `z.map()` / `z.set()` or as record keys, and compiled helpers (`s.slug()`, `s.raw()`, `s.toc()`, Markdown/MDX/asset fields) after a `.transform()` / `z.preprocess()` / `z.codec()` — they run on the raw input before Zod. Supported: `z.string().pipe(s.slug())`, `z.preprocess(fn, s.reference("authors"))`, `.catchall(s.reference(...))`, compiled fields inside `.default({})` / `.prefault({})` objects, and recursive (`z.lazy`) schemas at any depth.

## MDX import fails

`import`, `export … from`, dynamic `import()` and top-level `await` in MDX are rejected with the line. Pass components: `<MdxContent code={post.body} components={{ X }} />`.

## MDX blank under CSP

Rendering uses `new Function`. Allow `'unsafe-eval'` on pages that render MDX in the browser, or render on the server only. Edge runtimes (Cloudflare Workers, Vercel Edge) cannot render MDX at all — use a Node.js runtime.

## Markdown HTML stripped

Raw HTML is sanitized with `DEFAULT_SANITIZE_SCHEMA` (GitHub's schema plus `video` / `audio` / `source` / `track` / `picture` and responsive `img`; scripts, handlers, `style` removed). Pass your own `sanitizeSchema` (start from `DEFAULT_SANITIZE_SCHEMA`), or `allowDangerousHtml: true` for fully trusted content only. Your `rehypePlugins` run **after** sanitizing — a plugin that turns text into HTML can reintroduce XSS.

## Orama row rejected

**Symptom:** `orama: posts document "x" (…): … "title"`.

**Fix:** `index()` must return exactly the `schema` fields with matching types (e.g. `summary ?? ""` for optional strings).

## Orama `doc` not typed

Put `orama({...})` in the same `defineConfig({ content, plugins })` as the content tuple. Do not pass `content` or generics. Keys must be collection names.

## Search finds nothing in a non-Latin language

You probably set `languages: { sr: "english" }`. Remove it — the default Unicode tokenizer handles any script.

## Sharp under Bun

`bun pm untrusted` → trust `sharp` via `trustedDependencies`.

## Storage base mismatch

**Symptom:** "base … does not end with the storage prefix".

**Fix:** `base: "https://cdn.example.com/site/"` with `prefix: "site"`.

## Vite `base` and assets

Generated local asset URLs include Vite `base` (`/blog/anhur-assets/…`); files are copied to `dist/anhur-assets/`.

## Views

- `defineView` with `from: [posts, pages]` requires `select`.
- Views go in `views`, never in `content`.
- Duplicate `defineIndex` keys fail the build — use `s.unique()` or a composite key.
- `listSort` on numeric strings sorts as text — use `generate.compare` or store numbers.
- Callbacks that read embeds/transform fields need `createDerivedHelpers(content)`. With plain `defineView` / `defineIndex` / `defineGroup`, embed fields are opaque (`UnboundEmbed`) and cannot be keys.

## Hook snapshot cannot be changed

`ctx.documents()`, `onSuccess` and `complete` get frozen documents; `Map`, `Set` and `Date` values in them throw on `set` / `add` / `delete` / `setX`. Copy before changing (`new Map(value)`).

## Config not found

Default: `anhur.config.{ts,mts,js,mjs}` in the Vite root / `--root`. Pass `configPath` / `--config` otherwise. All paths in the config are relative to the config file.

## Light list missing a field

`allX` omits `generate.listOmit` (default `["body"]`) — also inside embeds. Use `getX()` or `listOmit: []` / `split: "full"`.
