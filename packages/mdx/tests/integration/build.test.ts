import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { build, isAnhurBuildError } from "@anhur/core/build";
import {
  createProject,
  PNG_1X1,
  type TestProject,
} from "../fixtures/temp-project";

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

const CONFIG = `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { definePlugin } from "@anhur/core/plugin";
import { mdx, schema as m } from "@anhur/mdx";

const assets = definePlugin({ name: "assets", assets: { base: "/a/", dir: ".anhur/assets" } });
const posts = defineCollection({
  name: "posts",
  directory: "posts",
  include: "*.mdx",
  schema: s.object({ title: s.string(), toc: s.toc(), body: m.body() }),
});
export default defineConfig({ content: [posts], plugins: [mdx(), assets] });
`;

describe("m.body()", () => {
  it("rewrites URLs in markdown, JSX attributes and JSX inside expressions", async () => {
    const project = await createProject({
      "anhur.config.ts": CONFIG,
      "posts/img/a.png": PNG_1X1,
      "posts/a.mdx": [
        "---",
        "title: A",
        "---",
        "# Heading",
        "",
        "![md](./img/a.png)",
        "",
        '<Figure src="./img/a.png" />',
        "",
        '<img src={"./img/a.png"} />',
        "",
        '{true && <img src="./img/a.png" />}',
        "",
        "[doc](./other.mdx)",
      ].join("\n"),
    });
    projects.push(project);
    await build({ rootDir: project.dir });
    const [moduleName] = await readdir(
      project.path(".anhur/generated/documents/posts"),
    );
    const output = await project.read(
      `.anhur/generated/documents/posts/${moduleName}`,
    );
    expect(output).not.toContain("./img/a.png");
    expect(
      output.match(/\/a\/a-[0-9a-f]{16}\.png/g)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(output).toContain("./other.mdx");
    expect(output).toContain(
      '"toc":[{"title":"Heading","url":"#heading","items":[]}]',
    );
    expect(output).toContain('id: \\"heading\\"');
  });

  it("reports MDX imports as field errors with the file", async () => {
    const project = await createProject({
      "anhur.config.ts": CONFIG,
      "posts/a.mdx": '---\ntitle: A\n---\nimport X from "./x.js"\n\n<X />',
    });
    projects.push(project);
    const error = await build({ rootDir: project.dir }).catch(
      (cause: unknown) => cause,
    );
    expect(isAnhurBuildError(error) && error.diagnostics[0]).toMatchObject({
      code: "field-failed",
      fieldPath: ["body"],
    });
  });
});

const MIXED_CONFIG = (plugin = "mdx()") => `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { definePlugin } from "@anhur/core/plugin";
import { mdx, schema as m } from "@anhur/mdx";

const assets = definePlugin({ name: "assets", assets: { base: "/a/", dir: ".anhur/assets" } });
const posts = defineCollection({
  name: "posts",
  directory: "posts",
  include: "*.{md,mdx}",
  schema: s.object({ title: s.string(), intro: m.mdx().optional(), toc: s.toc(), body: m.body() }),
});
export default defineConfig({ content: [posts], plugins: [${plugin}, assets] });
`;

const PostOutput = z.object({
  _meta: z.object({ id: z.string() }),
  toc: z.array(
    z.object({
      url: z.string(),
      title: z.string(),
      items: z.array(z.unknown()),
    }),
  ),
  body: z.string(),
  intro: z.string().optional(),
});
type PostOutput = z.infer<typeof PostOutput>;

async function buildPosts(
  files: { readonly [file: string]: string | Uint8Array },
  plugin?: string,
): Promise<Map<string, PostOutput>> {
  const project = await createProject({
    "anhur.config.ts": MIXED_CONFIG(plugin),
    "posts/img/a.png": PNG_1X1,
    ...files,
  });
  projects.push(project);
  await build({ rootDir: project.dir });
  const posts = new Map<string, PostOutput>();
  const folder = ".anhur/generated/documents/posts";
  for (const moduleName of await readdir(project.path(folder))) {
    const code = await project.read(`${folder}/${moduleName}`);
    const json = /^export default (\{.*\});$/m.exec(code)?.[1] ?? "null";
    const post = PostOutput.parse(JSON.parse(json));
    posts.set(post._meta.id, post);
  }
  return posts;
}

describe("m.body() review regressions", { timeout: 30_000 }, () => {
  it("rewrites only explicitly relative component props, plus JSX in exports and xlinkHref", async () => {
    const posts = await buildPosts({
      "posts/a.mdx": [
        "---",
        "title: A",
        "---",
        '<YouTube src="dQw4w9WgXcQ" />',
        "",
        '<CodeBlock src="example.ts" />',
        "",
        '<Docs.Figure src="./img/a.png" />',
        "",
        'export const Hero = () => <img src="./img/a.png" />',
        "",
        '<svg><use xlinkHref="./img/a.png#icon" /></svg>',
      ].join("\n"),
    });
    const body = posts.get("a")?.body ?? "";
    expect(body).toContain('"dQw4w9WgXcQ"');
    expect(body).toContain('"example.ts"');
    expect(body).not.toContain("./img/a.png");
    expect(body.match(/\/a\/a-[0-9a-f]{16}\.png/g)?.length).toBe(3);
    expect(body).toMatch(/\/a\/a-[0-9a-f]{16}\.png#icon/);
  });

  it("gives TOC anchors matching the compiled heading ids", async () => {
    const posts = await buildPosts({
      "posts/a.mdx": [
        "---",
        "title: A",
        "---",
        "```js",
        'import x from "y"',
        "export default x",
        "```",
        "",
        "## Use <Badge>new</Badge> API",
        "",
        "## Braces `{x}` in code",
        "",
        "## Hello {'world'}",
        "",
        "## Price {1+1} dollars",
      ].join("\n"),
    });
    const post = posts.get("a");
    expect(post?.toc.map((entry) => entry.url)).toEqual([
      "#use-new-api",
      "#braces-x-in-code",
      "#hello-",
      "#price--dollars",
    ]);
    for (const entry of post?.toc ?? []) {
      expect(post?.body).toContain(`id: "${entry.url.slice(1)}"`);
    }
  });

  it("keeps raw HTML in .md files and compiles m.mdx() fields as MDX", async () => {
    const posts = await buildPosts({
      "posts/b.md": [
        "---",
        "title: B",
        "intro: Hi <Badge>there</Badge>",
        "---",
        "<h2>Raw heading</h2>",
        "",
        'Press <kbd>K</kbd> <img src="./img/a.png">',
      ].join("\n"),
    });
    const post = posts.get("b");
    expect(post?.body).toContain('"kbd"');
    expect(post?.body).toMatch(/\/a\/a-[0-9a-f]{16}\.png/);
    expect(post?.toc).toEqual([
      { title: "Raw heading", url: "#raw-heading", items: [] },
    ]);
    expect(post?.body).toContain('id: "raw-heading"');
    expect(post?.intro).toContain("_components");
    expect(post?.intro).toContain("Badge");
    expect(post?.intro).not.toContain('"badge"');
  });

  it("appends the query / hash to documentLink results", async () => {
    const posts = await buildPosts(
      { "posts/a.mdx": "---\ntitle: A\n---\n[b](./b.mdx?x=1#part)" },
      'mdx({ documentLink: ({ target }) => "/blog/" + target.replace(/^posts\\//, "").replace(/\\.mdx$/, "") })',
    );
    expect(posts.get("a")?.body).toContain('"/blog/b?x=1#part"');
  });

  it("reports dynamic import() as a body field error", async () => {
    const project = await createProject({
      "anhur.config.ts": CONFIG,
      "posts/a.mdx":
        '---\ntitle: A\n---\nexport const fs = await import("node:fs")\n\nx',
    });
    projects.push(project);
    const error = await build({ rootDir: project.dir }).catch(
      (cause: unknown) => cause,
    );
    expect(isAnhurBuildError(error) && error.diagnostics).toEqual([
      expect.objectContaining({ code: "field-failed", fieldPath: ["body"] }),
    ]);
  });
});
