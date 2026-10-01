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

const config = (plugins: string) => `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { definePlugin } from "@anhur/core/plugin";
import { markdown, schema as md } from "@anhur/markdown";

const assets = definePlugin({ name: "assets", assets: { base: "/a/", dir: ".anhur/assets" } });

const rewriteDocs = () => (tree: { children: unknown[] }) => tree;

const pages = defineCollection({
  name: "pages",
  directory: "pages",
  include: "*.md",
  schema: s.object({ title: s.string(), summary: md.markdown().optional(), body: md.body() }),
});

export default defineConfig({ content: [pages], plugins: [${plugins}] });
`;

async function html(
  files: { readonly [file: string]: string | Uint8Array },
  plugins: string,
): Promise<string> {
  const project = await createProject({
    "anhur.config.ts": config(plugins),
    "pages/img/a.png": PNG_1X1,
    ...files,
  });
  projects.push(project);
  await build({ rootDir: project.dir });
  const [moduleName] = await readdir(
    project.path(".anhur/generated/documents/pages"),
  );
  return project.read(`.anhur/generated/documents/pages/${moduleName}`);
}

describe("md.body()", () => {
  it("rewrites relative files, keeps document links, ignores commented HTML", async () => {
    const output = await html(
      {
        "pages/a.md": [
          "---",
          "title: A",
          "summary: Read **this**",
          "---",
          '![pic](./img/a.png) <!-- <img src="./nope.png"> -->',
          "",
          '<p><img src="./img/a.png" width=10></p>',
          "",
          "[next](./b.md) [dir](../guide/) [top](#top) [ext](https://x.y) [mail](mailto:a@b.c)",
          "",
          '<picture><source srcset="./img/a.png 1x, ./img/a.png 2x"></picture>',
        ].join("\n"),
      },
      "markdown({ remarkPlugins: [rewriteDocs] }), assets",
    );
    expect(output).toMatch(/src=\\"\/a\/a-[0-9a-f]{16}\.png\\"/);
    expect(output).not.toContain("./img/a.png");
    expect(output).toContain('href=\\"./b.md\\"');
    expect(output).toContain('href=\\"../guide/\\"');
    expect(output).toContain("<strong>this</strong>");
    expect(output).not.toContain("nope.png");
  });

  it("maps document links with documentLink and keeps the query / hash", async () => {
    const output = await html(
      {
        "pages/a.md":
          "---\ntitle: A\n---\n[next](./guide/b.md?x=1#part) [dir](./guide/) [keep](./c.md#k)",
      },
      'markdown({ documentLink: ({ target }) => target.endsWith("c.md") ? undefined : "/docs/" + target.replace(/^pages\\/?/, "").replace(/\\.md$/, "") }), assets',
    );
    expect(output).toContain('href=\\"/docs/guide/b?x=1#part\\"');
    expect(output).toContain('href=\\"/docs/guide\\"');
    expect(output).toContain('href=\\"./c.md#k\\"');
  });

  it("compiles an empty body to an empty string", async () => {
    const output = await html(
      { "pages/a.md": "---\ntitle: A\n---\n" },
      "markdown(), assets",
    );
    expect(output).toContain('"body":""');
  });

  it("fails without the markdown plugin, and for relative files without an assets plugin", async () => {
    const noPlugin = await createProject({
      "anhur.config.ts": config(""),
      "pages/a.md": "---\ntitle: A\n---\nx",
    });
    projects.push(noPlugin);
    const error = await build({ rootDir: noPlugin.dir }).catch(
      (cause: unknown) => cause,
    );
    expect(isAnhurBuildError(error) && error.message).toContain(
      'needs the "markdown" plugin',
    );

    const noAssets = await createProject({
      "anhur.config.ts": config("markdown()"),
      "pages/a.md": "---\ntitle: A\n---\n![x](./img/a.png)",
      "pages/img/a.png": PNG_1X1,
    });
    projects.push(noAssets);
    const assetsError = await build({ rootDir: noAssets.dir }).catch(
      (cause: unknown) => cause,
    );
    expect(isAnhurBuildError(assetsError) && assetsError.message).toContain(
      "no plugin handles assets",
    );
  });
});

/** Config with `s.toc()` and an assets plugin that records published files. */
const REVIEW_CONFIG = (plugin: string, prelude = "") => `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { definePlugin } from "@anhur/core/plugin";
import { markdown, schema as md } from "@anhur/markdown";
${prelude}
const assets = definePlugin({
  name: "assets",
  assets: { base: "/a/", dir: ".anhur/assets" },
  beforePublish: (context) => {
    writeFileSync(join(context.projectDir, "published.json"), JSON.stringify(context.assets.map((asset) => asset.fileName)));
  },
});
const pages = defineCollection({
  name: "pages",
  directory: "pages",
  include: "*.md",
  schema: s.object({ title: s.string(), toc: s.toc(), body: md.body() }),
});
export default defineConfig({ content: [pages], plugins: [${plugin}, assets] });
`;

const PageOutput = z.object({
  toc: z.array(
    z.object({
      url: z.string(),
      items: z.array(z.object({ url: z.string() })),
    }),
  ),
  body: z.string(),
});
type PageOutput = z.infer<typeof PageOutput>;

async function buildPage(
  project: TestProject,
): Promise<{ readonly page: PageOutput; readonly published: string[] }> {
  await build({ rootDir: project.dir });
  const [moduleName] = await readdir(
    project.path(".anhur/generated/documents/pages"),
  );
  const code = await project.read(
    `.anhur/generated/documents/pages/${moduleName}`,
  );
  const json = /^export default (\{.*\});$/m.exec(code)?.[1] ?? "null";
  const page = PageOutput.parse(JSON.parse(json));
  const published = z
    .array(z.string())
    .parse(JSON.parse(await project.read("published.json")));
  return { page, published };
}

describe("md.body() review regressions", { timeout: 30_000 }, () => {
  it("never publishes files referenced by elements the sanitizer removes", async () => {
    const project = await createProject({
      "anhur.config.ts": REVIEW_CONFIG("markdown()"),
      "data/private.json": '{"secret":1}',
      "pages/img/a.png": PNG_1X1,
      "pages/a.md": [
        "---",
        "title: A",
        "---",
        '<object data="../data/private.json"></object>',
        "",
        '<embed src="./missing.png">',
        "",
        '<video src="./img/a.png" poster="./img/a.png" controls autoplay></video>',
      ].join("\n"),
    });
    projects.push(project);
    const { page, published } = await buildPage(project);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatch(/^a-[0-9a-f]{16}\.png$/);
    expect(page.body).not.toMatch(/private|missing|<object|<embed|autoplay/);
    expect(page.body).toMatch(
      /<video src="\/a\/a-[0-9a-f]{16}\.png" poster="\/a\/a-[0-9a-f]{16}\.png" controls><\/video>/,
    );
  });

  it("treats version-like and HTML links as pages, not files", async () => {
    const project = await createProject({
      "anhur.config.ts": REVIEW_CONFIG("markdown()"),
      "pages/a.md":
        "---\ntitle: A\n---\n[1.0](./release-1.0) [html](./other.html) [v](../v2.5.1#notes)",
    });
    projects.push(project);
    const { page } = await buildPage(project);
    expect(page.body).toContain('href="./release-1.0"');
    expect(page.body).toContain('href="./other.html"');
    expect(page.body).toContain('href="../v2.5.1#notes"');
  });

  it("gives TOC anchors that exist in the HTML, also for raw HTML and footnotes", async () => {
    const project = await createProject({
      "anhur.config.ts": REVIEW_CONFIG("markdown()"),
      "pages/a.md": [
        "---",
        "title: A",
        "---",
        "<h2>Setup</h2>",
        "",
        "## Setup",
        "",
        "## Foo <span>bar</span>",
        "",
        "### Press <kbd>K</kbd> ![logo](https://x.y/a.png)",
        "",
        "## Notes[^1]",
        "",
        "[^1]: A note.",
      ].join("\n"),
    });
    projects.push(project);
    const { page } = await buildPage(project);
    const urls = page.toc.flatMap((entry) => [
      entry.url,
      ...entry.items.map((item) => item.url),
    ]);
    expect(urls).toEqual([
      "#setup",
      "#setup-1",
      "#foo-bar",
      "#press-k-",
      "#notes1",
    ]);
    for (const url of urls) expect(page.body).toContain(`id="${url.slice(1)}"`);
    const hrefs = [...page.body.matchAll(/href="#([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const id of hrefs) expect(page.body).toContain(`id="${id}"`);
  });

  it("recompiles when a value captured by documentLink changes", async () => {
    const config = (base: string) =>
      REVIEW_CONFIG(
        "markdown({ documentLink: ({ target }) => BASE + target })",
        `const BASE = "${base}";`,
      );
    const project = await createProject({
      "anhur.config.ts": config("/one/"),
      "pages/a.md": "---\ntitle: A\n---\n[b](./b.md)",
    });
    projects.push(project);
    expect((await buildPage(project)).page.body).toContain(
      'href="/one/pages/b.md"',
    );
    await project.write("anhur.config.ts", config("/two/"));
    expect((await buildPage(project)).page.body).toContain(
      'href="/two/pages/b.md"',
    );
  });
});
