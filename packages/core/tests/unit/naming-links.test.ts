import { describe, expect, it } from "vitest";
import {
  arrayTypeName,
  camelCase,
  collectionTypeName,
  isValidIdentifier,
  listExportName,
  slugify,
} from "../../src/naming";
import {
  assetFileName,
  classifyUrl,
  hasDotSegment,
  isDocumentLinkPath,
  parseSrcset,
  serializeSrcset,
} from "../../src/plugin/links";

describe("naming", () => {
  it("pluralizes and singularizes real words", () => {
    expect(listExportName("posts")).toBe("allPosts");
    expect(listExportName("category")).toBe("allCategories");
    expect(listExportName("news")).toBe("allNews");
    expect(listExportName("status")).toBe("allStatuses");
    expect(collectionTypeName("people")).toBe("Person");
    expect(collectionTypeName("blog-posts")).toBe("BlogPost");
    expect(arrayTypeName("Post")).toBe("Posts");
    expect(arrayTypeName("News")).toBe("NewsList");
  });

  it("derives camelCase exports from hyphenated names", () => {
    expect(camelCase("site-settings")).toBe("siteSettings");
  });

  it("validates identifiers", () => {
    expect(isValidIdentifier("allPosts")).toBe(true);
    expect(isValidIdentifier("2024Post")).toBe(false);
    expect(isValidIdentifier("site-settings")).toBe(false);
    expect(isValidIdentifier("default")).toBe(false);
  });

  it("slugifies to ASCII", () => {
    expect(slugify("Hello Wörld!")).toBe("hello-world");
    expect(slugify("Čaša  vode")).toBe("casa-vode");
    expect(slugify("Здраво")).toBe("zdravo");
  });
});

describe("links", () => {
  it("treats every scheme as external, including javascript:", () => {
    for (const url of [
      "https://a.b",
      "//cdn/x.png",
      "mailto:a@b",
      "javascript:alert(1)",
      "sms:1",
      "blob:x",
      "data:image/png;base64,AA",
    ]) {
      expect(classifyUrl(url).kind).toBe("external");
    }
    expect(classifyUrl("/root.png").kind).toBe("root");
    expect(classifyUrl("#top").kind).toBe("fragment");
    expect(classifyUrl("?page=2").kind).toBe("query");
  });

  it("decodes relative paths and keeps the suffix", () => {
    expect(classifyUrl("./my%20pic.png?w=1#x")).toEqual({
      kind: "relative",
      path: "./my pic.png",
      suffix: "?w=1#x",
    });
  });

  it("recognizes links to documents", () => {
    expect(isDocumentLinkPath("./intro.md")).toBe(true);
    expect(isDocumentLinkPath("../guide/")).toBe(true);
    expect(isDocumentLinkPath("./intro")).toBe(true);
    expect(isDocumentLinkPath("./brochure.pdf")).toBe(false);
  });

  it("finds dot segments", () => {
    expect(hasDotSegment("../.env")).toBe(true);
    expect(hasDotSegment("a/.git/config")).toBe(true);
    expect(hasDotSegment("../img/a.png")).toBe(false);
  });

  it("parses srcset like browsers (data URLs keep their commas)", () => {
    const value = "data:image/png;base64,AAA,BBB 1x, ./b.png 2x,./c.png";
    const parsed = parseSrcset(value);
    expect(parsed).toEqual([
      { url: "data:image/png;base64,AAA,BBB", descriptor: "1x" },
      { url: "./b.png", descriptor: "2x" },
      { url: "./c.png", descriptor: "" },
    ]);
    expect(serializeSrcset(parsed)).toBe(
      "data:image/png;base64,AAA,BBB 1x, ./b.png 2x, ./c.png",
    );
  });

  it("builds safe content-hashed file names", () => {
    expect(assetFileName("My Photo.JPG", "0123456789abcdef")).toBe(
      "my-photo-0123456789abcdef.jpg",
    );
    expect(assetFileName("100%.png", "aa")).toBe("100-aa.png");
    expect(assetFileName("你好.svg", "bb")).toBe("asset-bb.svg");
  });
});
