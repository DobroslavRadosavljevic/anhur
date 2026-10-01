# `@anhur/mdx`

📝 MDX support for Anhur.

Use this when a content field should be MDX (Markdown with React components), not plain text.

## 📦 Install

```sh
bun add @anhur/mdx
```

You also need `@anhur/core` and `zod`. For rendering, keep `react` in the app.

## 🚀 Setup

Register the plugin **and** use an MDX field in your schema:

```ts
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { mdx, schema as m } from "@anhur/mdx";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.{md,mdx}",
  schema: s.object({
    title: s.string(),
    toc: s.toc(),
    body: m.body(), // the document body; m.mdx() compiles an MDX string field
  }),
});

export default defineConfig({
  content: [posts],
  plugins: [mdx()],
});
```

Using a field without `mdx()` in `plugins` fails the build with a clear message.

Options (on `mdx()`, or per field): `gfm` (default `true`), `headingIds` (default `true`, matching `s.toc()` anchors), `remarkPlugins`, `rehypePlugins` (run after link rewriting and heading ids), `documentLink`, and the `@mdx-js/mdx` options `format`, `recmaPlugins`, `remarkRehypeOptions`, `elementAttributeNameCase`, `stylePropertyNameCase`.

Options that do nothing or break with the function-body output fail config loading, on `mdx()` and on `m.body()` / `m.mdx()`: `jsxImportSource`, `jsx`, `jsxRuntime`, `pragma`, `pragmaFrag`, `pragmaImportSource`, `development`, `outputFormat`, `baseUrl`, `providerImportSource`. Rendering always uses React's automatic JSX runtime.

### `.md` files in an MDX collection

A document body in a Markdown file (`.md`, `.markdown`, …) is compiled with MDX's **Markdown format**: JSX, `{expressions}` and `import` / `export` are plain text there, and raw HTML (`<kbd>`, `<details>`, `<img>`) is kept as elements. Raw HTML is **not sanitized** (MDX content is trusted, see below); use [`@anhur/markdown`](https://www.npmjs.com/package/@anhur/markdown) for untrusted Markdown. `m.mdx()` string fields are always MDX. Set `format: "mdx"` (or `"md"`) to choose for every file.

### Heading ids and `s.toc()`

Headings get `github-slugger` ids from their rendered text: JSX children count, `{expressions}` do not (`## Hello {name}` → `hello-`). `s.toc()` asks `mdx()` for the headings, running the same pipeline (GFM, your `remarkPlugins`, heading ids), so every TOC `url` matches an `id` in the output. The TOC uses the `mdx()` options, not per-field options, and does not see `rehypePlugins` changes.

## ⚛️ Render in React

```tsx
import { MdxContent } from "@anhur/mdx/react";

export function PostBody({ code }: { code: string }) {
  return <MdxContent code={code} components={{ Callout }} />;
}
```

`code` is the compiled field (for example `post.body`) — a plain string, so it passes through route loaders. `useMdxComponent(code)` and `getMdxComponent(code)` return the component itself (cached per `code`).

## 🔒 Trust model

MDX is **code**: expressions and components run when the page renders, on the server and in the browser. Only compile content from people you would let commit code.

- `import`, `export … from`, dynamic `import()` (in `export` blocks, `{expressions}` and JSX attributes) and top-level `await` fail the build with the line number. Pass components through `components` instead.
- Local `export const x = …` is allowed.
- Rendering evaluates the compiled code with `new Function`. If your site sets a Content-Security-Policy, render MDX on the server only, or allow `'unsafe-eval'` for that page. Runtimes that forbid code generation — **Cloudflare Workers, Vercel Edge Functions** and other edge runtimes — cannot render it at all; render MDX in a Node.js runtime.

## 🖼️ Images and links in the body

With [`@anhur/assets`](https://www.npmjs.com/package/@anhur/assets) in `plugins`, relative URLs are copied and rewritten to public URLs in:

- Markdown images and links to files, and HTML / lower-case JSX elements (`<img src="./a.png" />`, `<video poster>`, `srcSet`, `<svg><use xlinkHref="./icons.svg#x" /></svg>`);
- props of your components, **only when the value starts with `./` or `../`**: `<Figure src="./a.png" />` is copied, `<YouTube src="dQw4w9WgXcQ" />` and `<CodeBlock src="example.ts" />` are left alone;
- string literals in JSX inside `{expressions}` and `export` blocks (`export const Hero = () => <img src="./hero.png" />`).

Only string literals are rewritten: template literals, ternaries and object props (``src={`./${name}.png`}``) are left as written. Links to other pages are left alone, or mapped with `documentLink` — same signature as in [`@anhur/markdown`](https://www.npmjs.com/package/@anhur/markdown) (`{ url, path, suffix, target, document }`; Anhur appends `?query#hash`).

## License

MIT
