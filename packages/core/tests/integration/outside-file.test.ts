/**
 * A singleton read from a file above the config folder, as a monorepo
 * package reads a root file (`filePath: "../registry.json"`).
 *
 * Ways it can fail, each checked below:
 * - the path is refused or resolved against the wrong folder;
 * - `ctx.documents()` of another source does not see the singleton;
 * - a change of the outside file is not seen by the next build of a session.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAnhur } from "../../src/build";
import { createProject, type TestProject } from "../fixtures/temp-project";

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

const CONFIG = `
import { defineCollection, defineConfig, defineSingleton, schema as s } from "@anhur/core";

const registry = defineSingleton({
  name: "registry",
  filePath: "../registry.json",
  localized: false,
  schema: s.object({ items: s.array(s.object({ name: s.string(), type: s.string() })) }),
});

const items = defineCollection({
  name: "items",
  directory: "content/items",
  include: "*.md",
  localized: false,
  schema: s.object({ title: s.string() }),
  transform: (doc, ctx) => {
    const entry = ctx.documents(registry)[0]?.items.find((item) => item.name === doc._meta.id);
    return { ...doc, type: entry?.type ?? "missing" };
  },
});

export default defineConfig({
  content: [registry, items],
  // The singleton's folder is the repo root: a scope folder inside it is fine,
  // because only the one file is read.
  scopes: [{ name: "public", outputDir: ".anhur/public" }],
});
`;

describe("a file above the config folder", () => {
  it("loads as a singleton that transforms can read, and rebuilds when it changes", async () => {
    const repo = await createProject({
      "registry.json": JSON.stringify({
        items: [{ name: "button", type: "registry:ui" }],
      }),
      "content-package/anhur.config.ts": CONFIG,
      "content-package/content/items/button.md": "---\ntitle: Button\n---\n",
    });
    projects.push(repo);
    const rootDir = repo.path("content-package");
    const session = createAnhur({ rootDir });
    // Read the file, not import(): Node keeps imported modules, and the
    // index imports its parts without a cache-busting query.
    const read = () =>
      repo.read("content-package/.anhur/generated/allItems.js");
    try {
      await session.build();
      expect(await read()).toContain('"registry:ui"');

      await repo.write(
        "registry.json",
        JSON.stringify({
          items: [{ name: "button", type: "registry:component" }],
        }),
      );
      const second = await session.build();
      expect(second.reuse.validated).toBe(1);
      expect(await read()).toContain('"registry:component"');
    } finally {
      await session.close();
    }
  });
});
