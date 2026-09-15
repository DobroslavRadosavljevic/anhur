import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build, formatAnhurError } from "../../src/index";

const scratchRoot = path.join(import.meta.dirname, "../.temp");
const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createScratch(prefix: string) {
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(path.join(scratchRoot, prefix));
  scratchRoots.push(root);
  return root;
}

describe("getter key collisions", () => {
  it("fails the build when two documents share a getter slug", async () => {
    const root = await createScratch("getter-collision-");
    await mkdir(path.join(root, "content/posts"), { recursive: true });
    await writeFile(
      path.join(root, "content/posts/hello.md"),
      `---
title: Hello
slug: hello
---

A
`,
    );
    await writeFile(
      path.join(root, "content/posts/other.md"),
      `---
title: Other
slug: hello
---

B
`,
    );
    await writeFile(
      path.join(root, "anhur.config.ts"),
      `import { defineCollection, defineConfig, schema as s } from "@anhur/core";

export default defineConfig({
  content: [
    defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      localized: false,
      schema: s.object({
        title: s.string(),
        slug: s.string(),
        body: s.raw(),
      }),
    }),
  ],
});
`,
    );

    await expect(build({ rootDir: root })).rejects.toSatisfy((error) =>
      formatAnhurError(error).includes("getter key"),
    );
  });
});
