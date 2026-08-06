import { describe, expect, it } from "vitest";
import { contentTypeFor } from "../../src/content-type";

describe("contentTypeFor", () => {
  it("maps common image extensions", () => {
    expect(contentTypeFor("a.png")).toBe("image/png");
    expect(contentTypeFor("a.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("a.jpeg")).toBe("image/jpeg");
    expect(contentTypeFor("a.gif")).toBe("image/gif");
    expect(contentTypeFor("a.webp")).toBe("image/webp");
  });

  it("maps svg to image/svg+xml", () => {
    expect(contentTypeFor("logo.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("/anhur-assets/logo-abc123.svg")).toBe(
      "image/svg+xml",
    );
  });

  it("maps other known extensions", () => {
    expect(contentTypeFor("doc.pdf")).toBe("application/pdf");
    expect(contentTypeFor("notes.txt")).toBe("text/plain; charset=utf-8");
  });

  it("falls back for unknown extensions", () => {
    expect(contentTypeFor("data.bin")).toBe("application/octet-stream");
  });
});
