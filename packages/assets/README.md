# `@anhur/assets`

🖼️ Images and files for Anhur content.

Point a schema field at a local image or file next to your Markdown/MDX/YAML/JSON. Anhur copies it into `.anhur/assets` and gives you a public URL in the generated data.

## 📦 Install

```sh
bun add @anhur/assets
```

You also need `@anhur/core`. Image handling uses [sharp](https://sharp.pixelplumbing.com/).

## 🚀 Setup

Register the assets processor **and** use `a.image()` / `a.file()` in your schema. Both are required.

```ts
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { assets, schema as a } from "@anhur/assets";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.{md,mdx}",
  schema: s.object({
    title: s.string(),
    cover: a.image(),
    attachment: a.file().optional(),
  }),
});

export default defineConfig({
  processors: [
    assets({
      dir: ".anhur/assets",
      base: "/anhur-assets/",
    }),
  ],
  content: [posts],
});
```

Example front matter:

```md
---
title: Hello
cover: ./cover.png
---
```

In the generated document, `cover` becomes something you can use as an image URL (plus metadata Anhur attaches).

## 🖼️ Images vs files

| Helper      | Use for                     | Result                                   |
| ----------- | --------------------------- | ---------------------------------------- |
| `a.image()` | Raster images and SVG       | `{ src, width, height, blurDataURL, … }` |
| `a.file()`  | Any file (PDF, SVG, zip, …) | `{ src }`                                |

SVG works with both. The original `.svg` is always copied as-is (not converted).

- With `a.image()`, Anhur fills in size and a small WebP blur placeholder when sharp can rasterize the SVG. If it cannot (for example an empty SVG with no size), the file still copies and blur fields stay empty.
- Prefer `a.file()` when you only need the public URL and do not care about width/height/blur.

## 🔗 Body images and links

If you also use `@anhur/mdx` or `@anhur/markdown`, relative URLs inside the body — like `![Alt](./photo.png)`, `![Logo](./logo.svg)`, or `[PDF](./spec.pdf)` — are copied and rewritten automatically when `assets()` is registered.

Without `assets()`, those relative body URLs fail the build so broken paths do not ship quietly.

## ⚡ With Vite

[`@anhur/vite`](https://www.npmjs.com/package/@anhur/vite) can serve the `.anhur/assets` folder in development so those URLs work while you write content. SVG is served as `image/svg+xml`.

## License

MIT
