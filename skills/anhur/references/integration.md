# Integration

## 1. Install

```sh
# Vite app (typical)
bun add @anhur/core @anhur/vite

# Opt-in processors (add only what schemas need)
bun add @anhur/mdx @anhur/markdown @anhur/assets
```

npm/pnpm/yarn work the same package names. Prefer the project’s package manager.

## 2. Config file

Place `anhur.config.ts` at the Vite root (or pass `anhur({ configPath: "…" })`). Paths in config (`directory`, `outputDir`, asset `dir`) are relative to the **config file’s directory**.

## 3. Vite

```ts
import anhur from "@anhur/vite";

export default defineConfig({
  plugins: [anhur()],
});
```

Do **not** manually alias `anhur/generated` in Vite — the plugin owns it. Still add the TypeScript `paths` entry.

## 4. TypeScript

```json
{
  "include": ["src", ".anhur/generated"],
  "compilerOptions": {
    "paths": {
      "anhur/generated": ["./.anhur/generated"]
    }
  }
}
```

Run a build once so `.anhur/generated` exists before `tsc` in CI, or commit generated output if the team prefers.

## 5. Content files

Example localized MDX:

```text
content/posts/en/hello.mdx
content/posts/de/hello.mdx
```

Front matter + body; schema fields must match.

Monolingual YAML authors:

```text
content/authors/jane.yml
```

with `localized: false` on that collection.

## 6. App imports

```ts
import { allPosts, getPost } from "anhur/generated";

const list = allPosts; // light items
const full = await getPost(list[0]!._meta.id);
if (!full) {
  // missing id — getters return null instead of throwing
}
```

Singletons export a const (and optional `*All` / getter per `generate`). Generated `_meta.filePath` is relative to the project root (safe to commit if you choose to).

## 7. Without Vite

```sh
bunx anhur build --root .
bunx anhur watch --root .
```

Use for CI, non-Vite frameworks, or prebuild scripts. Point `--config` if the file is not `anhur.config.ts` under `--root`.

## 8. Gitignore suggestions

```gitignore
.anhur/cache
# Optional — either commit generated for zero-build CI, or ignore and generate in CI:
# .anhur/generated
# .anhur/assets
```

If assets are ignored, production must run Anhur build (Vite plugin does this on `buildStart`).

## 9. Non-Vite frameworks

1. Run `anhur build` in a prebuild/CI step.
2. Resolve `anhur/generated` via bundler alias or `tsconfig` paths to `.anhur/generated`.
3. Serve `.anhur/assets` at `assets().base` (static copy or server middleware).

There is no official Next adapter yet — wire alias + prebuild manually.

## 10. Verify

```sh
bunx anhur build --root .
# or: bun run build / vite build
```

Then import generated modules in a route and render `MDXContent` / HTML as needed.
