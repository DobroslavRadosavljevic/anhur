# `@anhur/markdown`

📄 Markdown → HTML for Anhur.

Use this when a content field should become HTML you can print into the page — for docs, pages, or changelogs that do not need React components inside the body.

## 📦 Install

```sh
bun add @anhur/markdown
```

You also need `@anhur/core`.

## 🚀 Setup

Register the Markdown processor **and** use the Markdown field in your schema. Both are required.

```ts
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { markdown, schema as md } from "@anhur/markdown";

const pages = defineCollection({
  name: "pages",
  directory: "content/pages",
  include: "**/*.md",
  schema: s.object({
    title: s.string(),
    body: md.markdown(),
  }),
});

export default defineConfig({
  processors: [markdown({ gfm: true })],
  content: [pages],
});
```

If you use `md.markdown()` without `markdown()` in `processors`, the build fails on purpose so the mistake is obvious.

## ✨ Use the HTML

After generate, the field is an HTML string. In React:

```tsx
<article dangerouslySetInnerHTML={{ __html: page.body }} />
```

(Or pass it through your own sanitizer if the content is not fully trusted.)

## 🖼️ Images in the Markdown body

Want relative images like `![Alt](./hero.png)` to be copied and rewritten to public URLs?

Add [`@anhur/assets`](https://www.npmjs.com/package/@anhur/assets) and register `assets()` in `processors` as well.

## License

MIT
