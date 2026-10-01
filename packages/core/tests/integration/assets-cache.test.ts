import { readdir, symlink } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createAnhur, isAnhurBuildError } from "../../src/build";
import {
  createProject,
  PNG_1X1,
  type TestProject,
} from "../fixtures/temp-project";

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

/** A config with a `link` field that resolves through the field context and an asset host. */
const CONFIG = `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { defineField, definePlugin } from "@anhur/core/plugin";

let compiles = 0;
const link = () =>
  defineField(s.string(), {
    kind: "link",
    whenAbsent: "skip",
    cache: { version: "1", key: () => "k" },
    compile: async (input, context) => {
      compiles += 1;
      (globalThis as { anhurCompiles?: number }).anhurCompiles = compiles;
      const resolved = await context.resolveLink(String(input), "image");
      return resolved.url;
    },
  });

const posts = defineCollection({
  name: "posts",
  directory: "content",
  include: "*.md",
  schema: s.object({ cover: link(), draft: s.boolean().optional() }),
});

const host = definePlugin({
  name: "test-assets",
  assets: { base: "/files/", dir: ".anhur/assets", extensions: [".png"] },
});

export default defineConfig({ content: [posts], plugins: [host] });
`;

async function setup(files: { readonly [file: string]: string | Uint8Array }) {
  const project = await createProject({
    "anhur.config.ts": CONFIG,
    "content/img/a.png": PNG_1X1,
    ...files,
  });
  projects.push(project);
  return project;
}

async function failure(project: TestProject): Promise<string> {
  const session = createAnhur({ rootDir: project.dir });
  try {
    await session.build();
    return "no error";
  } catch (cause) {
    return isAnhurBuildError(cause)
      ? cause.diagnostics.map((d) => d.message).join("\n")
      : String(cause);
  } finally {
    await session.close();
  }
}

describe("asset policy", () => {
  it("emits hashed, URL-safe files under the public base", async () => {
    const project = await setup({
      "content/a.md": "---\ncover: ./img/a.png?w=1\n---\n",
    });
    const session = createAnhur({ rootDir: project.dir });
    try {
      const result = await session.build();
      expect(result.assets).toMatchObject({ publicBase: "/files/", count: 1 });
      expect(await project.read(".anhur/generated/allPosts.js")).toMatch(
        /"cover":"\/files\/a-[0-9a-f]{16}\.png\?w=1"/,
      );
    } finally {
      await session.close();
    }
  });

  it("refuses files outside the project, dotfiles, symlinks out, missing files and other extensions", async () => {
    const outside = await setup({
      "content/a.md": "---\ncover: ../../../../../../../../etc/hosts\n---\n",
    });
    expect(await failure(outside)).toMatch(
      /outside the folders assets may be read from|not found/,
    );

    const dotfile = await setup({
      "content/a.md": "---\ncover: ./.env\n---\n",
      "content/.env": "SECRET=1",
    });
    expect(await failure(dotfile)).toMatch(/dotfile/);

    const linked = await setup({
      "content/a.md": "---\ncover: ./link.png\n---\n",
    });
    await symlink("/etc/hosts", linked.path("content/link.png"));
    expect(await failure(linked)).toMatch(/outside the folders/);

    const missing = await setup({
      "content/a.md": "---\ncover: ./nope.png\n---\n",
    });
    expect(await failure(missing)).toMatch(/File not found/);

    const wrongType = await setup({
      "content/a.md": "---\ncover: ./x.html\n---\n",
      "content/x.html": "<script></script>",
    });
    expect(await failure(wrongType)).toMatch(/does not allow/);
  });

  it("does not publish assets of drafts", async () => {
    const project = await setup({
      "content/a.md": "---\ncover: ./img/a.png\n---\n",
      "content/b.md": "---\ncover: ./img/b.png\ndraft: true\n---\n",
      "content/img/b.png": Buffer.concat([PNG_1X1, Buffer.from([0])]),
    });
    const session = createAnhur({ rootDir: project.dir });
    try {
      expect((await session.build()).assets?.count).toBe(1);
    } finally {
      await session.close();
    }
  });
});

describe("field cache", () => {
  it("reuses compiled fields across sessions and invalidates when an asset changes", async () => {
    const project = await setup({
      "content/a.md": "---\ncover: ./img/a.png\n---\n",
    });
    // SAFETY: the test config's field writes its compile count to this global (same process).
    const store = globalThis as { anhurCompiles?: number };
    const run = async () => {
      const session = createAnhur({ rootDir: project.dir });
      try {
        await session.build();
      } finally {
        await session.close();
      }
      return store.anhurCompiles ?? 0;
    };
    store.anhurCompiles = 0;
    expect(await run()).toBe(1);
    store.anhurCompiles = 0;
    expect(await run()).toBe(0);
    await project.write(
      "content/img/a.png",
      Buffer.concat([PNG_1X1, Buffer.from([1])]),
    );
    store.anhurCompiles = 0;
    expect(await run()).toBe(1);
    const entries = await readdir(project.path(".anhur/cache/fields"));
    expect(entries.filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });
});
