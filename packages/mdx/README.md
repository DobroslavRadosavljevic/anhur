# `@anhur/mdx`

📝 MDX support for Anhur.

Use this when a content field should be MDX (Markdown with React components), not plain text.

## 📦 Install

```sh
bun add @anhur/mdx
```

You also need `@anhur/core`. For rendering in React, keep `react` and `react-dom` in the app.

## 🚀 Setup

Register the MDX processor **and** use the MDX field in your schema. Both are required.

```ts
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { mdx, schema as m } from "@anhur/mdx";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.{md,mdx}",
  schema: s.object({
    title: s.string(),
    body: m.mdx(),
  }),
});

export default defineConfig({
  processors: [mdx({ gfm: true })],
  content: [posts],
});
```

If you use `m.mdx()` without `mdx()` in `processors`, the build fails on purpose so the mistake is obvious.

## ⚛️ Render in React

```tsx
import { MDXContent } from "@anhur/mdx/react";

export function PostBody({ code }: { code: string }) {
  return <MDXContent code={code} />;
}
```

`code` is the compiled MDX string from your generated document (for example `post.body`).

## 🖼️ Images in the MDX body

Want relative images like `![Alt](./cover.png)` to be copied and rewritten to public URLs?

Add [`@anhur/assets`](https://www.npmjs.com/package/@anhur/assets) and register `assets()` in `processors` as well.

## License

MIT
