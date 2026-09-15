import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ConfigLoader, nodeLiveLayer } from "../../src/index";

const scratchRoot = path.join(import.meta.dirname, "../.temp");
const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("config import cache", () => {
  it("reloads cms collection modules on the next load of the same ConfigLoader", async () => {
    await mkdir(scratchRoot, { recursive: true });
    const root = await mkdtemp(path.join(scratchRoot, "config-modules-"));
    scratchRoots.push(root);

    await mkdir(path.join(root, "cms/collections"), { recursive: true });
    await mkdir(path.join(root, "cms/content/posts"), { recursive: true });
    await writeFile(
      path.join(root, "cms/content/posts/one.md"),
      `---
title: One
---

Body
`,
    );

    const collectionPath = path.join(root, "cms/collections/posts.ts");
    const writeCollection = async (name: string) => {
      await writeFile(
        collectionPath,
        `import { defineCollection, schema as s } from "@anhur/core";

export const posts = defineCollection({
  name: ${JSON.stringify(name)},
  directory: "cms/content/posts",
  include: "**/*.md",
  localized: false,
  schema: s.object({
    title: s.string(),
    body: s.raw(),
  }),
});
`,
      );
    };

    await writeCollection("posts");
    await writeFile(
      path.join(root, "anhur.config.ts"),
      `import { defineConfig } from "@anhur/core";
import { posts } from "./cms/collections/posts";

export default defineConfig({
  content: [posts],
});
`,
    );

    const names = await Effect.runPromise(
      Effect.gen(function* () {
        const loader = yield* ConfigLoader;
        const first = yield* loader.load(root);
        yield* Effect.promise(() => writeCollection("articles"));
        const second = yield* loader.load(root);
        return [first.config.content[0]!.name, second.config.content[0]!.name];
      }).pipe(Effect.provide(nodeLiveLayer)),
    );

    expect(names).toEqual(["posts", "articles"]);
  });
});
