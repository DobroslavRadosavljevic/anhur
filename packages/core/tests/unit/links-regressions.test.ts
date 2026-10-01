import path from "node:path";
import type { Root } from "hast";
import { describe, expect, it } from "vitest";
import {
  rehypeLinkedAssets,
  type DocumentLink,
} from "../../src/plugin/linked-assets";
import {
  classifyUrl,
  isAssetLinkPath,
  isDocumentLinkPath,
} from "../../src/plugin/links";
import type {
  FieldContext,
  LinkRole,
  ResolvedLink,
} from "../../src/plugin/types";

const PROJECT = path.resolve("/project");

/** A field context that records links and "copies" every relative file. */
function fakeContext(): FieldContext & { readonly seen: string[] } {
  const seen: string[] = [];
  const resolveLink = async (
    url: string,
    role: LinkRole,
  ): Promise<ResolvedLink> => {
    seen.push(`${role}:${url}`);
    const classified = classifyUrl(url);
    if (classified.kind !== "relative") return { kind: "external", url };
    if (role === "link" && isDocumentLinkPath(classified.path)) {
      return { kind: "document", url, path: classified.path };
    }
    const src = `/a/${path.posix.basename(classified.path)}`;
    return {
      kind: "asset",
      url: `${src}${classified.suffix}`,
      asset: {
        src,
        sourcePath: classified.path,
        fileName: src,
        hash: "0",
        size: 1,
        contentType: "x",
      },
    };
  };
  return {
    seen,
    document: {
      id: "guides/intro",
      locale: "en",
      source: "docs",
      filePath: path.join(PROJECT, "content/docs/en/guides/intro.md"),
      meta: {
        id: "guides/intro",
        filePath: "content/docs/en/guides/intro.md",
        relativePath: "en/guides/intro.md",
        extension: ".md",
        locale: "en",
      },
    },
    fieldPath: ["body"],
    body: "",
    projectDir: PROJECT,
    mode: "build",
    configFingerprint: "x",
    getPlugin: () => undefined,
    resolveLink,
    emitAsset: () => Promise.reject(new Error("unused")),
    addDependency: () => undefined,
    warn: () => undefined,
  };
}

function element(
  tagName: string,
  properties: Record<string, string>,
): Root["children"][number] {
  return { type: "element", tagName, properties, children: [] };
}

/** An MDX JSX node (typed through the `mdast-util-mdx` hast augmentation). */
function jsx(
  name: string,
  attributes: Record<string, string>,
): Root["children"][number] {
  return {
    type: "mdxJsxFlowElement",
    name,
    attributes: Object.entries(attributes).map(([key, value]) => ({
      type: "mdxJsxAttribute",
      name: key,
      value,
    })),
    children: [],
  };
}

async function run(
  children: Root["children"],
  documentLink?: (link: DocumentLink) => string | undefined,
) {
  const context = fakeContext();
  const tree: Root = { type: "root", children };
  await rehypeLinkedAssets({ context, documentLink })(tree);
  return { tree, seen: context.seen };
}

describe("link classification", () => {
  it("treats versions, HTML pages and unknown extensions as page links", () => {
    for (const page of [
      "./release-1.0",
      "./v2.5.1",
      "./other.html",
      "./other.htm",
      "./intro.mdx",
      "../guide/",
      "./intro",
      ".",
    ]) {
      expect([page, isAssetLinkPath(page)]).toEqual([page, false]);
      expect(isDocumentLinkPath(page)).toBe(true);
    }
    for (const file of [
      "./brochure.pdf",
      "./a.PNG",
      "./archive.tar.gz",
      "./data.yaml",
    ]) {
      expect([file, isAssetLinkPath(file)]).toEqual([file, true]);
    }
  });

  it("uses the asset host's extensions for custom file types", () => {
    expect(isAssetLinkPath("./model.usdz")).toBe(false);
    expect(isAssetLinkPath("./model.usdz", [".usdz"])).toBe(true);
    expect(isDocumentLinkPath("./model.usdz", [".usdz"])).toBe(false);
    expect(isAssetLinkPath("./page.html", [".html"])).toBe(false);
  });
});

describe("rehypeLinkedAssets", () => {
  it("rewrites component props only when they are explicitly relative", async () => {
    const youtube = jsx("YouTube", { src: "dQw4w9WgXcQ" });
    const code = jsx("Docs.CodeBlock", { src: "example.ts" });
    const figure = jsx("Figure", { src: "./hero.png" });
    const img = jsx("img", { src: "hero.png" });
    const { tree, seen } = await run([youtube, code, figure, img]);
    expect(seen).toEqual(["media:./hero.png", "image:hero.png"]);
    expect(JSON.stringify(tree)).toContain('"value":"/a/hero.png"');
    expect(JSON.stringify(tree)).toContain('"value":"dQw4w9WgXcQ"');
  });

  it("rewrites iframe, SVG use / image, link and cite URLs", async () => {
    const nodes = [
      element("iframe", { src: "./demo/" }),
      element("use", { xLinkHref: "./sprite.svg#icon" }),
      element("image", { href: "./a.png" }),
      element("link", { href: "./style.css" }),
      element("blockquote", { cite: "./source.md" }),
    ];
    const { tree, seen } = await run(nodes);
    expect(seen).toEqual([
      "link:./demo/",
      "image:./sprite.svg#icon",
      "image:./a.png",
      "link:./style.css",
      "link:./source.md",
    ]);
    const html = JSON.stringify(tree);
    expect(html).toContain("/a/sprite.svg#icon");
    expect(html).toContain("/a/style.css");
  });

  it("passes suffix and project-relative target to documentLink and appends the suffix", async () => {
    const calls: Omit<DocumentLink, "document">[] = [];
    const { tree } = await run(
      [
        element("a", { href: "./setup.md?tab=1#install" }),
        element("a", { href: "../reference/" }),
        element("a", { href: "./keep.md#x" }),
      ],
      ({ document, ...link }) => {
        calls.push(link);
        expect(document.locale).toBe("en");
        if (link.target.endsWith("keep.md")) return undefined;
        const slug = link.target
          .replace(/^content\/docs\/en\//, "")
          .replace(/\.mdx?$/, "");
        return `/docs/${document.locale ?? ""}/${slug}`;
      },
    );
    expect(calls).toEqual([
      {
        url: "./setup.md?tab=1#install",
        path: "./setup.md",
        suffix: "?tab=1#install",
        target: "content/docs/en/guides/setup.md",
      },
      {
        url: "../reference/",
        path: "../reference/",
        suffix: "",
        target: "content/docs/en/reference",
      },
      {
        url: "./keep.md#x",
        path: "./keep.md",
        suffix: "#x",
        target: "content/docs/en/guides/keep.md",
      },
    ]);
    const html = JSON.stringify(tree);
    expect(html).toContain('"/docs/en/guides/setup?tab=1#install"');
    expect(html).toContain('"/docs/en/reference"');
    expect(html).toContain('"./keep.md#x"');
  });
});
