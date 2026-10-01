import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
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

/**
 * A field that resolves its input through the field context (role from
 * `role`), and an asset host whose transform version and roots come from
 * globals set by the test (same process).
 */
const CONFIG = `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { defineField, definePlugin } from "@anhur/core/plugin";

type Globals = { anhurVersion?: string; anhurRoots?: string[]; anhurCompiles?: number };
const globals = globalThis as Globals;

const link = (role: "image" | "link") =>
  defineField(s.string(), {
    kind: "link",
    whenAbsent: "skip",
    cache: { version: "1", key: () => role },
    compile: async (input, context) => {
      globals.anhurCompiles = (globals.anhurCompiles ?? 0) + 1;
      const resolved = await context.resolveLink(String(input), role);
      return resolved.kind + ":" + resolved.url;
    },
  });

const posts = defineCollection({
  name: "posts",
  directory: "content",
  include: "*.md",
  schema: s.object({ cover: link("image").optional(), href: link("link").optional() }),
});

const version = globals.anhurVersion;
const host = definePlugin({
  name: "test-assets",
  assets: {
    base: "/files/",
    dir: ".anhur/assets",
    extensions: [".png", ".svg"],
    roots: globals.anhurRoots,
    transformVersion: (extension) => (extension === ".svg" ? version : undefined),
  },
});

export default defineConfig({ content: [posts], plugins: [host] });
`;

type Globals = {
  anhurVersion?: string;
  anhurRoots?: string[];
  anhurCompiles?: number;
};
// SAFETY: the test config reads these globals in the same process.
const globals = globalThis as Globals;

afterEach(() => {
  delete globals.anhurVersion;
  delete globals.anhurRoots;
  delete globals.anhurCompiles;
});

async function setup(files: { readonly [file: string]: string | Uint8Array }) {
  const project = await createProject({ "anhur.config.ts": CONFIG, ...files });
  projects.push(project);
  return project;
}

async function run(project: TestProject, rootDir = project.dir) {
  const session = createAnhur({ rootDir });
  try {
    await session.build();
    return await project.read(".anhur/generated/allPosts.js");
  } catch (cause) {
    return isAnhurBuildError(cause)
      ? cause.diagnostics.map((d) => d.message).join("\n")
      : String(cause);
  } finally {
    await session.close();
  }
}

function sha(value: string, version?: string): string {
  const hash = createHash("sha256");
  if (version !== undefined) hash.update(`${version}\0`);
  return hash.update(value).digest("hex").slice(0, 16);
}

describe("asset hashes", () => {
  it("hash the bytes, plus the host's transform version when it has one", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const project = await setup({
      "content/a.md": "---\ncover: ./logo.svg\n---\n",
      "content/logo.svg": svg,
    });
    expect(await run(project)).toContain(
      `"cover":"asset:/files/logo-${sha(svg)}.svg"`,
    );

    globals.anhurVersion = "sanitize-1";
    globals.anhurCompiles = 0;
    expect(await run(project)).toContain(
      `"cover":"asset:/files/logo-${sha(svg, "sanitize-1")}.svg"`,
    );
    // The cached field value was not replayed with the old name.
    expect(globals.anhurCompiles).toBe(1);
  });
});

describe("asset roots", () => {
  it("use the most specific root, so a root inside a dot-folder works", async () => {
    globals.anhurRoots = [".shared"];
    const project = await setup({
      "content/a.md": "---\ncover: ../.shared/a.png\n---\n",
      ".shared/a.png": PNG_1X1,
    });
    expect(await run(project)).toMatch(
      /"cover":"asset:\/files\/a-[0-9a-f]{16}\.png"/,
    );
  });

  it("refuse node_modules unless it is inside an explicit root", async () => {
    const project = await setup({
      "content/a.md": "---\ncover: ../node_modules/pkg/a.png\n---\n",
      "node_modules/pkg/a.png": PNG_1X1,
    });
    expect(await run(project)).toContain("inside node_modules");

    globals.anhurRoots = ["node_modules/pkg"];
    expect(await run(project)).toMatch(/"cover":"asset:\/files\/a-/);
  });

  it("match files whatever case the project path is spelled in", async () => {
    const project = await setup({
      "content/a.md": "---\ncover: ./a.png\n---\n",
      "content/a.png": PNG_1X1,
    });
    const upper = project.dir.toUpperCase();
    const caseInsensitive = await readdir(upper).then(
      () => true,
      () => false,
    );
    if (!caseInsensitive) return;
    expect(await run(project, upper)).toMatch(/"cover":"asset:\/files\/a-/);
  });
});

describe("link role", () => {
  it("leaves page links alone and copies only allowed asset extensions", async () => {
    const project = await setup({
      "content/a.md": "---\nhref: ./release-1.0#notes\n---\n",
      "content/b.md": "---\nhref: ./other.html?x=1\n---\n",
      "content/c.md": "---\nhref: ./guide/\n---\n",
      "content/d.md": "---\nhref: ./a.png#x\n---\n",
      "content/a.png": PNG_1X1,
    });
    const output = await run(project);
    expect(output).toContain('"href":"document:./release-1.0#notes"');
    expect(output).toContain('"href":"document:./other.html?x=1"');
    expect(output).toContain('"href":"document:./guide/"');
    expect(output).toMatch(/"href":"asset:\/files\/a-[0-9a-f]{16}\.png#x"/);
  });

  it("still refuses other extensions for images, and file links the host does not allow", async () => {
    const image = await setup({
      "content/a.md": "---\ncover: ./x.html\n---\n",
      "content/x.html": "<script></script>",
    });
    expect(await run(image)).toMatch(/does not allow/);
    const archive = await setup({
      "content/a.md": "---\nhref: ./backup.zip\n---\n",
      "content/backup.zip": "PK",
    });
    expect(await run(archive)).toMatch(
      /"\.zip", which assets\(\{ extensions \}\) does not allow/,
    );
  });
});
