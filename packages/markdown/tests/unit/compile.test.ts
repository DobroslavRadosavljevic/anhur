import { tocFromHeadings } from "@anhur/core/plugin";
import { describe, expect, it } from "vitest";
import {
  COMPILER_VERSION,
  compileMarkdown,
  extractMarkdownHeadings,
} from "../../src/compile";
import { markdown } from "../../src";

describe("compileMarkdown", () => {
  it("sanitizes raw HTML by default", async () => {
    const html = await compileMarkdown(
      '<img src="x.png" onerror="alert(1)"><script>alert(2)</script>\n\n[x](javascript:alert(3)) <iframe srcdoc="<b>x</b>"></iframe>',
    );
    expect(html).not.toMatch(/onerror|<script|javascript:|iframe/);
    expect(html).toContain('<img src="x.png">');
  });

  it("keeps raw HTML only when allowDangerousHtml is set", async () => {
    const html = await compileMarkdown("<script>x()</script>", {
      allowDangerousHtml: true,
    });
    expect(html).toContain("<script>x()</script>");
  });

  it("allows media and responsive images, with safe URLs only", async () => {
    const html = await compileMarkdown(
      [
        '<video src="./clip.mp4" poster="javascript:alert(1)" controls autoplay onplay="x()"><source src="./clip.webm" type="video/webm"><track src="./en.vtt" kind="captions" srclang="en" label="English" default></video>',
        "",
        '<audio src="https://cdn.example.com/a.mp3" controls></audio>',
        "",
        '<picture><source srcset="./a.avif 1x, ./a@2x.avif 2x" type="image/avif"><img src="./a.png" srcset="./a.png 1x, ./a@2x.png 2x" sizes="50vw" loading="lazy" decoding="async"></picture>',
        "",
        '<video src="data:video/mp4;base64,AAA"></video>',
      ].join("\n"),
    );
    expect(html).toContain(
      '<video src="./clip.mp4" controls><source src="./clip.webm" type="video/webm"><track src="./en.vtt" kind="captions" srclang="en" label="English" default></video>',
    );
    expect(html).toContain(
      '<audio src="https://cdn.example.com/a.mp3" controls></audio>',
    );
    expect(html).toContain(
      '<img src="./a.png" srcset="./a.png 1x, ./a@2x.png 2x" sizes="50vw" loading="lazy" decoding="async">',
    );
    expect(html).toContain('<source srcset="./a.avif 1x, ./a@2x.avif 2x"');
    expect(html).not.toMatch(/javascript:|autoplay|onplay|data:video/);
  });

  it("links GFM footnotes and raw anchors to their prefixed ids", async () => {
    const html = await compileMarkdown(
      'Text[^note] and <a href="#top">top</a>.\n\n<a id="top"></a>\n\n[^note]: A note.',
    );
    expect(html).not.toContain("user-content-user-content-");
    const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(hrefs).toEqual([
      "user-content-fn-note",
      "user-content-top",
      "user-content-fnref-note",
    ]);
    for (const id of hrefs) expect(html).toContain(`id="${id}"`);
  });

  it("keeps footnote links working without sanitizing", async () => {
    const html = await compileMarkdown("Text[^1]\n\n[^1]: A note.", {
      allowDangerousHtml: true,
    });
    const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(hrefs.length).toBe(2);
    for (const id of hrefs) expect(html).toContain(`id="${id}"`);
  });

  it("reports the headings of the compiled HTML with their ids", async () => {
    const source = [
      "# Hello World",
      "",
      "<h2>Setup</h2>",
      "",
      "## Setup",
      "",
      "## Foo <span>bar</span>",
      "",
      "### Press <kbd>K</kbd> ![logo](https://x.y/a.png)",
      "",
      '<h2 id="custom">Custom</h2>',
      "",
      "## Café & Co[^1]",
      "",
      "[^1]: Note.",
    ].join("\n");
    const html = await compileMarkdown(source);
    const headings = await extractMarkdownHeadings(source);
    expect(headings.map((heading) => heading.id)).toEqual([
      "hello-world",
      "setup",
      "setup-1",
      "foo-bar",
      "press-k-",
      "user-content-custom",
      "café--co1",
    ]);
    for (const heading of headings) {
      expect(html).toContain(`id="${heading.id}"`);
    }
    const toc = tocFromHeadings(headings);
    expect(toc[0]?.items.map((entry) => entry.title)).toEqual([
      "Setup",
      "Setup",
      "Foo bar",
      "Custom",
      "Café & Co1",
    ]);
  });

  it("supports GFM and can turn it off", async () => {
    const table = "| a |\n| - |\n| 1 |";
    expect(await compileMarkdown(table)).toContain("<table>");
    expect(await compileMarkdown(table, { gfm: false })).not.toContain(
      "<table>",
    );
  });
});

describe("cache keys", () => {
  it("cover the sanitizer, the slugger and the package versions", () => {
    for (const name of [
      "hast-util-sanitize@",
      "github-slugger@",
      "hast-util-to-string@",
      "mdast-util-to-hast@",
      "hast-util-raw@",
    ]) {
      expect(COMPILER_VERSION).toContain(name);
    }
    expect(COMPILER_VERSION).not.toContain("unknown");
    expect(COMPILER_VERSION.split(",").slice(0, 2)).toEqual([
      "@anhur/markdown@0.0.14",
      "@anhur/core@0.0.14",
    ]);
  });

  it("report headings only when heading ids are on", () => {
    expect(markdown().headings).toBeDefined();
    expect(markdown({ headingIds: false }).headings).toBeUndefined();
  });
});
