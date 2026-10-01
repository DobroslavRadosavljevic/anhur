import { describe, expect, it } from "vitest";
import {
  joinPublicAssetBase,
  resolveAssetBases,
} from "../../src/engine/asset-urls";
import { contentTypeForPath } from "../../src/mime";

describe("contentTypeForPath", () => {
  it("knows web document types", () => {
    expect(contentTypeForPath("a.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeForPath("a.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeForPath("a.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeForPath("a.mjs")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeForPath("a.unknown")).toBe("application/octet-stream");
  });
});

describe("resolveAssetBases", () => {
  it("strips the app base from the local prefix", () => {
    expect(resolveAssetBases("/anhur-assets/", "/app/")).toEqual({
      publicBase: "/app/anhur-assets/",
      localBase: "/anhur-assets/",
    });
    expect(resolveAssetBases("/app/a/", "/app/")).toEqual({
      publicBase: "/app/a/",
      localBase: "/a/",
    });
  });

  it("uses / as the local prefix when assets sit at the app root", () => {
    expect(resolveAssetBases("/x/", "/x")).toEqual({
      publicBase: "/x/",
      localBase: "/",
    });
  });

  it("percent-encodes bases and keeps existing escapes", () => {
    expect(resolveAssetBases("/my assets/", "/")).toEqual({
      publicBase: "/my%20assets/",
      localBase: "/my%20assets/",
    });
    expect(resolveAssetBases("/a%20b/").publicBase).toBe("/a%20b/");
    expect(resolveAssetBases("/50%/").publicBase).toBe("/50%25/");
    expect(resolveAssetBases("https://cdn.example.com/p q/")).toEqual({
      publicBase: "https://cdn.example.com/p%20q/",
      localBase: undefined,
    });
    expect(joinPublicAssetBase("/my app/", "/a/")).toBe("/my%20app/a/");
  });
});
