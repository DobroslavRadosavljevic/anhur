import { describe, expect, it } from "vitest";
import {
  collectHtmlAssetUrls,
  collectSrcsetUrls,
  isLinkedAssetAttrName,
  isSrcsetAttrName,
  mapSrcsetUrls,
  parseSrcset,
  rewriteHtmlAssetAttrValue,
  serializeSrcset,
} from "../../src/srcset";

describe("parseSrcset", () => {
  it("keeps density descriptors", () => {
    expect(parseSrcset("./a.png 1x, ./b.png 2x")).toEqual([
      { url: "./a.png", descriptor: "1x" },
      { url: "./b.png", descriptor: "2x" },
    ]);
  });

  it("keeps width descriptors and tight commas", () => {
    expect(parseSrcset("./a.png 400w,./b.png 800w")).toEqual([
      { url: "./a.png", descriptor: "400w" },
      { url: "./b.png", descriptor: "800w" },
    ]);
  });

  it("allows a single URL with no descriptor", () => {
    expect(parseSrcset("./a.png")).toEqual([
      { url: "./a.png", descriptor: "" },
    ]);
  });

  it("skips empty candidates from a trailing comma", () => {
    expect(parseSrcset("./a.png 1x, ")).toEqual([
      { url: "./a.png", descriptor: "1x" },
    ]);
  });
});

describe("mapSrcsetUrls", () => {
  it("rewrites only matching candidates and serializes descriptors", () => {
    expect(
      mapSrcsetUrls("./a.png 1x, https://cdn/b.png 2x", (url) =>
        url === "./a.png" ? "/anhur-assets/a-abc.png" : url,
      ),
    ).toBe("/anhur-assets/a-abc.png 1x, https://cdn/b.png 2x");
  });
});

describe("serializeSrcset", () => {
  it("omits the space when there is no descriptor", () => {
    expect(serializeSrcset([{ url: "/a.png", descriptor: "" }])).toBe("/a.png");
  });
});

describe("html asset attrs", () => {
  it("collects srcset candidates separately from src", () => {
    expect(
      collectHtmlAssetUrls(
        '<img src="./a.png" srcset="./a.png 1x, ./b.png 2x" alt="">',
      ),
    ).toEqual(["./a.png", "./a.png", "./b.png"]);
  });

  it("rewrites a URL in both src and srcset without dropping descriptors", () => {
    const html = '<img src="./a.png" srcset="./a.png 1x, ./b.png 2x" alt="x">';
    const next = rewriteHtmlAssetAttrValue(html, "./a.png", "/out/a.png");
    expect(next).toContain('src="/out/a.png"');
    expect(next).toContain('srcset="/out/a.png 1x, ./b.png 2x"');
  });

  it("collects imagesrcset candidates", () => {
    expect(collectSrcsetUrls("./a.png 1x, ./b.png 2x")).toEqual([
      "./a.png",
      "./b.png",
    ]);
    expect(
      collectHtmlAssetUrls(
        '<link rel="preload" as="image" imagesrcset="./a.png 1x, ./b.png 2x">',
      ),
    ).toEqual(["./a.png", "./b.png"]);
  });

  it("does not treat data-src or data-srcset as asset attrs", () => {
    expect(
      collectHtmlAssetUrls(
        '<img data-src="./lazy.png" data-srcset="./a.png 1x, ./b.png 2x" src="./real.png">',
      ),
    ).toEqual(["./real.png"]);
  });

  it("rewrites imagesrcset candidates", () => {
    const html =
      '<link rel="preload" as="image" imagesrcset="./a.png 1x, ./b.png 2x">';
    const next = rewriteHtmlAssetAttrValue(html, "./a.png", "/out/a.png");
    expect(next).toContain('imagesrcset="/out/a.png 1x, ./b.png 2x"');
  });
});

describe("attr name helpers", () => {
  it("treats React srcSet as a srcset attribute", () => {
    expect(isSrcsetAttrName("srcSet")).toBe(true);
    expect(isSrcsetAttrName("imageSrcSet")).toBe(true);
    expect(isLinkedAssetAttrName("srcSet")).toBe(true);
    expect(isLinkedAssetAttrName("poster")).toBe(true);
    expect(isSrcsetAttrName("src")).toBe(false);
  });
});
