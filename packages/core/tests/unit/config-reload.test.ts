import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../../src/index";

const fixtureRoot = path.join(import.meta.dirname, "../fixtures/config-reload");
const configPath = path.join(fixtureRoot, "anhur.config.ts");

const postsConfig = `import { defineCollection, defineConfig } from "@anhur/core";
import { z } from "zod";

export default defineConfig({
  content: [
    defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      schema: z.object({
        title: z.string(),
        content: z.string(),
      }),
    }),
  ],
});
`;

const articlesConfig = `import { defineCollection, defineConfig } from "@anhur/core";
import { z } from "zod";

export default defineConfig({
  content: [
    defineCollection({
      name: "articles",
      directory: "content/posts",
      include: "**/*.md",
      schema: z.object({
        title: z.string(),
        content: z.string(),
      }),
    }),
  ],
});
`;

describe("config reload across builds", () => {
  afterEach(async () => {
    await writeFile(configPath, postsConfig);
    await rm(path.join(fixtureRoot, ".anhur"), {
      recursive: true,
      force: true,
    });
  });

  it("picks up anhur.config.ts edits on the next build", async () => {
    await writeFile(configPath, postsConfig);
    await build({ rootDir: fixtureRoot });
    const first = await readFile(
      path.join(fixtureRoot, ".anhur/generated/index.js"),
      "utf8",
    );
    expect(first).toContain("allPosts");
    expect(first).not.toContain("allArticles");

    await writeFile(configPath, articlesConfig);
    await build({ rootDir: fixtureRoot });
    const second = await readFile(
      path.join(fixtureRoot, ".anhur/generated/index.js"),
      "utf8",
    );
    expect(second).toContain("allArticles");
    expect(second).not.toContain("allPosts");
  });
});
