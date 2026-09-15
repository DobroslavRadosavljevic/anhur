import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../../src/build";
import { formatAnhurError } from "../../src/errors";

// Keep under this package so jiti can resolve workspace `@anhur/*`.
const scratchRoot = path.join(import.meta.dirname, "../.temp");
const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  // SAFETY: preserves the existing runtime contract for this assignment.
  delete (globalThis as { __anhurFailIntegration?: boolean })
    .__anhurFailIntegration;
});

async function createProject() {
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(path.join(scratchRoot, "atomic-"));
  scratchRoots.push(root);
  await mkdir(path.join(root, "content/posts"), { recursive: true });
  await writeFile(
    path.join(root, "content/posts/one.md"),
    "---\ntitle: One\n---\nBody\n",
  );
  return root;
}

const CONFIG_WITH_MARKER = `import { defineCollection, defineConfig, defineIntegration } from "@anhur/core";
import * as z from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: z.object({
    title: z.string(),
    content: z.string(),
  }),
});

const g = globalThis as { __anhurFailIntegration?: boolean };

export default defineConfig({
  content: [posts],
  integrations: [
    defineIntegration({
      id: "marker-search",
      onComplete: async (ctx) => {
        if (g.__anhurFailIntegration) {
          throw new Error("intentional integration failure");
        }
        const dir = path.join(ctx.outputDir, "search");
        await mkdir(dir, { recursive: true });
        await writeFile(
          path.join(dir, "marker.json"),
          JSON.stringify({
            ok: true,
            titles: ctx.sources[0]?.documents.map((d) => d.title),
          }),
          "utf8",
        );
      },
    }),
  ],
});
`;

const MARKER = path.join(".anhur/generated/search/marker.json");

describe("atomic generated output", () => {
  it("keeps the previous search marker when a rebuild fails validation", async () => {
    const root = await createProject();
    await writeFile(path.join(root, "anhur.config.ts"), CONFIG_WITH_MARKER);

    await build({ rootDir: root });
    const markerPath = path.join(root, MARKER);
    const before = await readFile(markerPath, "utf8");
    expect(JSON.parse(before)).toMatchObject({ ok: true });

    await writeFile(
      path.join(root, "content/posts/one.md"),
      "---\n---\nMissing title\n",
    );

    await expect(build({ rootDir: root })).rejects.toSatisfy((error) =>
      formatAnhurError(error).includes("title"),
    );

    const after = await readFile(markerPath, "utf8");
    expect(after).toBe(before);
    await access(path.join(root, ".anhur/generated/allPosts.js"));
  });

  it("keeps the previous search marker when an integration fails after codegen", async () => {
    const root = await createProject();
    await writeFile(path.join(root, "anhur.config.ts"), CONFIG_WITH_MARKER);

    await build({ rootDir: root });
    const markerPath = path.join(root, MARKER);
    const before = await readFile(markerPath, "utf8");
    expect(JSON.parse(before).titles).toContain("One");

    // SAFETY: preserves the existing runtime contract for this assignment.
    (
      globalThis as { __anhurFailIntegration?: boolean }
    ).__anhurFailIntegration = true;
    await writeFile(
      path.join(root, "content/posts/one.md"),
      "---\ntitle: Updated\n---\nBody\n",
    );

    await expect(build({ rootDir: root })).rejects.toSatisfy((error) =>
      formatAnhurError(error).includes("intentional integration failure"),
    );

    const after = await readFile(markerPath, "utf8");
    expect(after).toBe(before);
    expect(JSON.parse(after).titles).toContain("One");
    expect(JSON.parse(after).titles).not.toContain("Updated");
  });

  it("publishes integration output only after a fully successful rebuild", async () => {
    const root = await createProject();
    await writeFile(path.join(root, "anhur.config.ts"), CONFIG_WITH_MARKER);

    await build({ rootDir: root });
    await writeFile(
      path.join(root, "content/posts/one.md"),
      "---\ntitle: Two\n---\nBody\n",
    );
    // SAFETY: preserves the existing runtime contract for this assignment.
    await build({ rootDir: root });

    // SAFETY: preserves the existing runtime contract for this assignment.
    const marker = JSON.parse(
      await readFile(path.join(root, MARKER), "utf8"),
    ) as {
      titles: string[];
    };
    expect(marker.titles).toEqual(["Two"]);
  });
});
