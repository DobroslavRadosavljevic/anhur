import { extractHeadings } from "@anhur/core/plugin";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { compileMdx, extractMdxHeadings, mdx, schema } from "../../src";
import { COMPILER_VERSION } from "../../src/compile";
import { getMdxComponent, MdxContent } from "../../src/react";

describe("compileMdx", () => {
  it("rejects imports and re-exports at build time", async () => {
    await expect(
      compileMdx('import Chart from "./chart.js"\n\n# x'),
    ).rejects.toThrow(/imports are not supported/);
    await expect(
      compileMdx('export { a } from "./a.js"\n\n# x'),
    ).rejects.toThrow(/re-exports \(export … from\) are not supported/);
  });

  it("allows local exports and renders with components", async () => {
    const code = await compileMdx(
      "export const n = 2\n\n# Title {n}\n\n<Badge>ok</Badge>",
    );
    const html = renderToStaticMarkup(
      createElement(MdxContent, {
        code,
        components: {
          Badge: (props: { children?: unknown }) =>
            createElement("b", null, String(props.children)),
        },
      }),
    );
    expect(html).toBe('<h1 id="title-">Title 2</h1>\n<b>ok</b>');
  });

  it("caches evaluated components by code", async () => {
    const code = await compileMdx("hello");
    expect(getMdxComponent(code)).toBe(getMdxComponent(code));
  });

  it("rejects dynamic import() and top-level await with the line", async () => {
    for (const [source, message] of [
      [
        '{import("node:fs").then((fs) => fs)}',
        /dynamic import\(\) is not supported \(line 1\)/,
      ],
      [
        'x\n\n<X a={import("y")} />',
        /dynamic import\(\) is not supported \(line 3\)/,
      ],
      ['<X {...import("y")} />', /dynamic import\(\) is not supported/],
      [
        'export const fs = await import("node:fs")',
        /dynamic import\(\) is not supported|top-level await/,
      ],
      [
        "export const n = await Promise.resolve(1)",
        /top-level await is not supported \(line 1\)/,
      ],
      ['export * from "./a.js"', /re-exports/],
    ] as const) {
      await expect(compileMdx(source)).rejects.toThrow(message);
    }
    await expect(compileMdx("x")).resolves.toContain("MDXContent");
    await expect(
      compileMdx("export const f = async () => await 1\n\nx"),
    ).resolves.toBeTypeOf("string");
    await expect(compileMdx('import a from "a"')).rejects.toThrow(
      /<MdxContent components=/,
    );
  });

  it("rejects options that do nothing with function-body output", () => {
    const pluginOptions = { gfm: true, jsxImportSource: "preact" };
    const plugin = mdx(pluginOptions);
    const errors: string[] = [];
    void plugin.setup?.({
      projectDir: "",
      mode: "build",
      outputDir: "",
      sources: [],
      contentRoots: [],
      locales: [],
      error: (message) => {
        errors.push(message);
      },
      warn: () => undefined,
    });
    expect(errors).toEqual([
      expect.stringContaining('option "jsxImportSource" is not supported'),
    ]);
    const fieldOptions = { gfm: true, development: true };
    expect(() => schema.body(fieldOptions)).toThrow(
      /m\.body\(\): option "development" is not supported/,
    );
    const baseUrl = { gfm: true, baseUrl: "x" };
    expect(() => schema.mdx(baseUrl)).toThrow(/m\.mdx\(\): option "baseUrl"/);
  });

  it("reports heading ids exactly as the compiled output has them", async () => {
    const source = [
      "## Use <Badge>new</Badge> API",
      "## Braces `{x}` in code",
      "## Code `<T>` generic",
      "## Hello {'world'}",
      "## Price {1+1} dollars",
      "export const x = 1",
      "## Same",
      "## Same",
    ].join("\n\n");
    const code = await compileMdx(source);
    const headings = await extractMdxHeadings(source);
    const ids = headings.map((heading) => heading.id);
    expect(ids).toEqual([
      "use-new-api",
      "braces-x-in-code",
      "code-t-generic",
      "hello-",
      "price--dollars",
      "same",
      "same-1",
    ]);
    for (const id of ids) expect(code).toContain(`id: "${id}"`);
    // The built-in fallback parser (no mdx() plugin) agrees.
    expect(
      extractHeadings(source, { mdx: true }).map((heading) => heading.id),
    ).toEqual(ids);
  });

  it("has a cache version covering MDX internals and the package versions", () => {
    expect(COMPILER_VERSION).toMatch(/(^|,)@anhur\/mdx@\d+\.\d+\.\d+/);
    expect(COMPILER_VERSION).toMatch(/(^|,)@anhur\/core@\d+\.\d+\.\d+/);
    for (const name of [
      "remark-mdx@",
      "mdast-util-to-hast@",
      "github-slugger@",
      "hast-util-to-string@",
    ]) {
      expect(COMPILER_VERSION).toContain(name);
    }
    expect(COMPILER_VERSION).not.toContain("unknown");
    expect(mdx({ headingIds: false }).headings).toBeUndefined();
  });
});
