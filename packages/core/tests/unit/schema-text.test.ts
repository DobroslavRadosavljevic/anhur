import { describe, expect, it } from "vitest";
import { z } from "zod";
import { splitFrontmatter, matterLoader, yamlLoader } from "../../src/loaders";
import { schema as s } from "../../src/schema";
import { parseIsoDate } from "../../src/schema/builtin-fields";
import {
  countWords,
  stripInvalidMdx,
  toPlainText,
  truncateText,
} from "../../src/schema/text";
import {
  buildToc,
  extractHeadings,
  tocFromHeadings,
} from "../../src/schema/toc";
import { analyzeSchema, walkInput } from "../../src/schema/walk";

describe("text helpers", () => {
  it("counts words in any script", () => {
    expect(countWords("Здраво свете, ово је текст", "sr")).toBe(5);
    expect(countWords("příliš žluťoučký kůň", "cs")).toBe(3);
  });

  it("truncates on grapheme boundaries within the limit", () => {
    const out = truncateText("😀😀😀😀😀", 3);
    expect(out).toBe("😀😀…");
    expect([...new Intl.Segmenter().segment(out)].length).toBeLessThanOrEqual(
      3,
    );
  });

  it("drops MDX imports, JSX and expressions from plain text", () => {
    const mdx =
      'import Chart from "./chart";\n\n# Title\n\n<Chart data={1} />\n\nText {props.x} here.';
    expect(toPlainText(mdx, { mdx: true })).toBe("Title Text here.");
    expect(toPlainText("Keep {braces} in Markdown")).toBe(
      "Keep {braces} in Markdown",
    );
  });

  it("keeps headings after a skipped level", () => {
    const toc = buildToc("# A\n\n### C\n\n## B\n");
    expect(toc).toEqual([
      {
        title: "A",
        url: "#a",
        items: [
          { title: "C", url: "#c", items: [] },
          { title: "B", url: "#b", items: [] },
        ],
      },
    ]);
    expect(buildToc("")).toEqual([]);
  });
});

const FENCE = "```";

describe("body text and TOC regressions", () => {
  it("keeps MDX headings after code blocks with import / export lines", () => {
    const mdx = [
      "# A",
      "",
      `${FENCE}js`,
      'import x from "y"',
      "export default x",
      FENCE,
      "",
      "## B",
      "",
      "## C",
    ].join("\n");
    expect(buildToc(mdx, { mdx: true })).toEqual([
      {
        title: "A",
        url: "#a",
        items: [
          { title: "B", url: "#b", items: [] },
          { title: "C", url: "#c", items: [] },
        ],
      },
    ]);
  });

  it("keeps MDX headings between fences with unbalanced braces", () => {
    const mdx = [
      "## One",
      `${FENCE}js`,
      "const a = {",
      FENCE,
      "## Two",
      `${FENCE}js`,
      "}",
      FENCE,
      "## Three",
    ].join("\n");
    expect(buildToc(mdx, { mdx: true }).map((entry) => entry.title)).toEqual([
      "One",
      "Two",
      "Three",
    ]);
    expect(toPlainText(mdx, { mdx: true })).toBe("One Two Three");
  });

  it("keeps JSX children and drops expressions in MDX plain text", () => {
    expect(
      toPlainText("<Button onClick={() => go()}>Go</Button> now", {
        mdx: true,
      }),
    ).toBe("Go now");
    expect(
      toPlainText("export const meta = {\n  a: 1,\n}\n\nHello {meta.a}", {
        mdx: true,
      }),
    ).toBe("Hello");
  });

  it("parses Markdown excerpts with GFM", () => {
    const text = toPlainText(
      "| a | b |\n| - | - |\n| 1 | 2 |\n\n~~old~~ new[^1]\n\n[^1]: Note.",
    );
    expect(text).not.toMatch(/[|~]/);
    expect(text).toBe("a b 1 2 old new Note.");
  });

  it("falls back to a fence-aware strip for invalid MDX", () => {
    const invalid = [
      "# Title <Broken",
      "",
      "import x from 'y'",
      "",
      `${FENCE}`,
      "{ <Keep> }",
      FENCE,
      "",
      "## Next {x} `{y}`",
    ].join("\n");
    expect(stripInvalidMdx(invalid)).toContain("{ <Keep> }");
    expect(stripInvalidMdx(invalid)).not.toContain("import x");
    expect(
      buildToc(invalid, { mdx: true }).flatMap((entry) => [
        entry.title,
        ...entry.items.map((item) => item.title),
      ]),
    ).toEqual(["Title <Broken", "Next {y}"]);
    expect(toPlainText(invalid, { mdx: true })).toBe("Title <Broken Next {y}");
  });

  it("slugs heading text the way rehype-slug sees the compiled heading", () => {
    const ids = (source: string, mdx = false) =>
      extractHeadings(source, { mdx }).map((heading) => heading.id);
    expect(ids("## Foo <span>bar</span>\n\n## Key <kbd>K</kbd>")).toEqual([
      "foo-bar",
      "key-k",
    ]);
    expect(ids("## Logo ![alt](./a.png) here")).toEqual(["logo--here"]);
    expect(
      ids(
        [
          "## Use <Badge>new</Badge> API",
          "## Braces `{x}` in code",
          "## Code `<T>` generic",
          "## Hello {'world'}",
          "## Price {1+1} dollars",
        ].join("\n\n"),
        true,
      ),
    ).toEqual([
      "use-new-api",
      "braces-x-in-code",
      "code-t-generic",
      "hello-",
      "price--dollars",
    ]);
    expect(ids("## Same\n\n## Same")).toEqual(["same", "same-1"]);
  });

  it("nests headings, filters by maxDepth and skips empty titles", () => {
    const toc = tocFromHeadings(
      [
        { depth: 2, id: "a", text: "A" },
        { depth: 4, id: "b", text: "B" },
        { depth: 3, id: "c", text: " C  d " },
        { depth: 2, id: "", text: "  " },
        { depth: 1, id: "e", text: "E" },
      ],
      { maxDepth: 3 },
    );
    expect(toc).toEqual([
      {
        title: "A",
        url: "#a",
        items: [{ title: "C d", url: "#c", items: [] }],
      },
      { title: "E", url: "#e", items: [] },
    ]);
  });
});

describe("s.isodate", () => {
  it("parses strictly and without the machine time zone", () => {
    expect(parseIsoDate("2024-02-29")).toMatchObject({
      ok: true,
      epoch: Date.UTC(2024, 1, 29),
    });
    expect(parseIsoDate("2024-01-01T10:00")).toMatchObject({
      ok: true,
      epoch: Date.UTC(2024, 0, 1, 10),
    });
    expect(parseIsoDate("2024-01-01T10:00+02:00")).toMatchObject({
      ok: true,
      epoch: Date.UTC(2024, 0, 1, 8),
    });
    expect(parseIsoDate("2024-02-30").ok).toBe(false);
    expect(parseIsoDate("1").ok).toBe(false);
    expect(parseIsoDate("hello 2020").ok).toBe(false);
  });

  it("outputs ISO timestamps or calendar dates", () => {
    expect(s.isodate().parse("2024-05-01")).toBe("2024-05-01T00:00:00.000Z");
    expect(
      s.isodate({ output: "date" }).parse(new Date(Date.UTC(2024, 4, 1))),
    ).toBe("2024-05-01");
  });
});

describe("loaders", () => {
  it("rejects code-executing frontmatter languages", () => {
    expect(() => splitFrontmatter("---js\n{ a: 1 }\n---\n")).toThrow(
      /not supported/,
    );
  });

  it("parses YAML frontmatter with dates as strings (same as .yaml files)", async () => {
    const md = await matterLoader.load({
      path: "a.md",
      raw: "﻿---\ndate: 2024-01-02\n---\n\nBody\n",
    });
    const yml = await yamlLoader.load({
      path: "a.yml",
      raw: "date: 2024-01-02\n",
    });
    expect(md).toEqual({ data: { date: "2024-01-02" }, body: "Body\n" });
    expect(yml.data.date).toBe(md.data.date);
  });

  it("reports unclosed frontmatter and duplicate keys", () => {
    expect(() => splitFrontmatter("---\ntitle: x\n")).toThrow(/not closed/);
    expect(() =>
      matterLoader.load({ path: "a.md", raw: "---\na: 1\na: 2\n---\n" }),
    ).toThrow();
  });
});

describe("schema walker", () => {
  const schema = s.object({
    slug: s.slug(),
    author: s.reference("authors").optional(),
    tags: s.array(s.object({ ref: s.reference("tags") })),
    meta: s.object({ sku: s.unique() }).default({ sku: "x" }),
    block: s.discriminatedUnion("kind", [
      s.object({ kind: s.literal("a"), body: s.raw() }),
      s.object({ kind: s.literal("b") }),
    ]),
  });

  it("finds fields statically, with wildcard array items", () => {
    const fields = analyzeSchema(schema).fields.map((field) => [
      field.spec.type,
      field.pattern.map((p) => (p.kind === "key" ? p.key : "[]")).join("."),
    ]);
    expect(fields).toEqual([
      ["compile", "slug"],
      ["reference", "author"],
      ["reference", "tags.[].ref"],
      ["unique", "meta.sku"],
      ["compile", "block.body"],
    ]);
  });

  it("walks input through optional, default, arrays and discriminated unions", () => {
    const found = walkInput(schema, {
      tags: [{ ref: "a" }, { ref: "b" }],
      block: { kind: "a" },
    }).map((occurrence) => [occurrence.path.join("."), occurrence.present]);
    expect(found).toEqual([
      ["slug", false],
      ["author", false],
      ["tags.0.ref", true],
      ["tags.1.ref", true],
      ["meta.sku", true],
      ["block.body", false],
    ]);
  });

  it("reports field helpers inside plain unions", () => {
    const issues = analyzeSchema(
      z.object({ x: z.union([s.slug(), z.number()]) }),
    ).issues;
    expect(issues).toHaveLength(1);
  });

  it("keeps markers through refinements and descriptions", () => {
    const refined = s
      .reference("authors")
      .describe("author")
      .refine((value) => value.length > 1);
    expect(analyzeSchema(z.object({ a: refined })).fields).toHaveLength(1);
  });
});
