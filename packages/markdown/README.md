# `@anhur/markdown`

📄 Markdown → HTML for Anhur.

Use this when a content field should become HTML you can print into the page — for docs, pages, or changelogs that do not need React components inside the body.

## 📦 Install

```sh
bun add @anhur/markdown
```

You also need `@anhur/core` and `zod`.

## 🚀 Setup

Register the plugin **and** use a Markdown field in your schema:

```ts
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { markdown, schema as md } from "@anhur/markdown";

const pages = defineCollection({
  name: "pages",
  directory: "content/pages",
  include: "**/*.md",
  schema: s.object({
    title: s.string(),
    summary: md.markdown().optional(), // a Markdown string field in the front matter
    body: md.body(), // the document body (the text after the front matter)
  }),
});

export default defineConfig({
  content: [pages],
  plugins: [markdown()],
});
```

| Field           | Compiles                                   |
| --------------- | ------------------------------------------ |
| `md.body()`     | the document body                          |
| `md.markdown()` | a Markdown string field (`.optional()` ok) |

Using a field without `markdown()` in `plugins` fails the build with a clear message.

## 🛡️ Safe by default

Raw HTML in Markdown is **sanitized**: `<script>`, `<iframe>`, `<object>`, event handlers, `style` and `javascript:` URLs are removed, so the output is safe to insert:

```tsx
<article dangerouslySetInnerHTML={{ __html: page.body }} />
```

The default schema is exported as `DEFAULT_SANITIZE_SCHEMA`: GitHub's schema (`rehype-sanitize`'s `defaultSchema`) plus media:

- `<video>` with `src`, `poster`, `controls`, `loop`, `muted`, `playsInline`, `preload`, `width`, `height` (no `autoPlay`)
- `<audio>` with `src`, `controls`, `loop`, `muted`, `preload`
- `<source>` with `src`, `srcSet`, `type`, `media`, `sizes`; `<track>` with `src`, `kind`, `srcLang`, `label`, `default`; `<picture>`
- `<img>` with `srcSet`, `sizes`, `loading`, `decoding`

`src`, `poster` and `srcSet` URLs must be relative or `http(s)`. To allow more, extend the default instead of starting from scratch:

```ts
import { DEFAULT_SANITIZE_SCHEMA, markdown } from "@anhur/markdown";

markdown({
  sanitizeSchema: {
    ...DEFAULT_SANITIZE_SCHEMA,
    attributes: {
      ...DEFAULT_SANITIZE_SCHEMA.attributes,
      video: [...(DEFAULT_SANITIZE_SCHEMA.attributes?.video ?? []), "autoPlay"],
    },
  },
});
```

Elements the sanitizer removes never reach link rewriting: a removed `<object data="../private.json">` does not publish that file.

Options (on `markdown()`, or per field — field options win, plugin lists run first):

| Option               | Default                   | What it does                                                        |
| -------------------- | ------------------------- | ------------------------------------------------------------------- |
| `gfm`                | `true`                    | Tables, task lists, strikethrough, autolinks, footnotes             |
| `headingIds`         | `true`                    | `id`s on headings, matching `s.toc()` anchors                       |
| `sanitizeSchema`     | `DEFAULT_SANITIZE_SCHEMA` | Custom `rehype-sanitize` schema                                     |
| `allowDangerousHtml` | `false`                   | Keep raw HTML as written — **only for fully trusted content**       |
| `remarkPlugins`      | `[]`                      | Run on the Markdown tree, before HTML exists                        |
| `rehypePlugins`      | `[]`                      | Run **after** sanitizing, on the final HTML (see the warning below) |
| `documentLink`       | —                         | Rewrite links to other pages (see below)                            |

> [!WARNING]
> `rehypePlugins` run after sanitizing, link rewriting and heading ids. Whatever they add — raw HTML, `style`, event handlers, `javascript:` URLs, relative file URLs — is **not** sanitized and **not** copied. Only use rehype plugins you trust to emit safe HTML.

Order of the pipeline: parse (+ GFM) → `remarkPlugins` → HTML (raw HTML parsed) → sanitize → relative files copied and links rewritten → heading ids → `rehypePlugins` → serialize.

## 🔗 Heading ids, footnotes and `s.toc()`

Headings get ids from their text with `github-slugger` (`## Café & Co` → `café--co`; repeats get `-1`, `-2`). They are **not** prefixed, so a heading can take an id your page also uses (`#main`, `#content`); give such headings other text or set `headingIds: false`.

Ids written in raw HTML (`<h2 id="x">`, `<a id="x">`, `name`) **are** prefixed by the sanitizer to `user-content-x`, so content cannot clobber page ids. Links to them (`[jump](#x)`) are rewritten to `#user-content-x` when `x` itself does not exist. GFM footnotes use the same prefix (`#user-content-fn-1`), and their links work.

`s.toc()` asks `markdown()` for the headings: the same pipeline runs (GFM, your `remarkPlugins`, raw HTML, sanitizing, heading ids), so every TOC `url` is an `id` in `body` — also for headings with inline HTML, raw `<h2>` headings and repeated titles. The TOC uses the plugin options (not per-field options), and does not see changes made by `rehypePlugins`.

## 🖼️ Images and links in the body

With [`@anhur/assets`](https://www.npmjs.com/package/@anhur/assets) in `plugins`, relative images and files are copied and rewritten to public URLs: `![Alt](./hero.png)`, `<img src srcset>`, `<video src poster>`, `<audio>`, `<source src srcset>`, `<track>`, and links to files (`[Brochure](./brochure.pdf)`). Without it, relative asset links fail the build.

A relative link is a **page link** (never copied) when it points at a directory (`../guide/`), has no extension (`./intro`), has an unknown extension such as a version (`./release-1.0`), or is a page (`.md`, `.mdx`, `.markdown`, `.html`, `.htm`). Known file types (`.png`, `.pdf`, `.zip`, `.yaml`, …) and the extensions you allow in `assets({ extensions })` are files.

Page links are left as written, or mapped to routes with `documentLink`:

```ts
markdown({
  // In content/docs/en/guides/intro.md: [Setup](./setup.md?tab=cli#install)
  documentLink: ({ target, document }) => {
    // target: "content/docs/en/guides/setup.md" (project-relative, POSIX)
    const root = document.locale
      ? `content/docs/${document.locale}/`
      : "content/docs/";
    if (!target.startsWith(root)) return undefined; // not a docs page: keep the link
    const slug = target
      .slice(root.length)
      .replace(/\.mdx?$/, "")
      .replace(/(^|\/)index$/, "");
    return document.locale
      ? `/docs/${document.locale}/${slug}`
      : `/docs/${slug}`;
  },
}); // → /docs/en/guides/setup?tab=cli#install
```

The resolver receives:

| Field      | Example                            | Meaning                                                  |
| ---------- | ---------------------------------- | -------------------------------------------------------- |
| `url`      | `./setup.md?tab=cli#install`       | The link as written                                      |
| `path`     | `./setup.md`                       | Decoded path part, relative to the document              |
| `suffix`   | `?tab=cli#install`                 | Query and hash as written                                |
| `target`   | `content/docs/en/guides/setup.md`  | Linked file or directory, relative to the project, POSIX |
| `document` | `{ id, locale, source, filePath }` | The document with the link (`filePath` is absolute)      |

Return the URL **without** query and hash — Anhur appends `suffix`. Return `undefined` to keep the link unchanged.

## License

MIT
