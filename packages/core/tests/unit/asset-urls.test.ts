import { describe, expect, it } from "vitest";
import {
  assetsOutDirSegment,
  joinPublicAssetBase,
  relativeAssetRequestPath,
  resolvePublicAndLocalAssetBases,
} from "../../src/asset-urls";

describe("joinPublicAssetBase", () => {
  it("leaves a default assets base unchanged when the app base is /", () => {
    expect(joinPublicAssetBase("/", "/anhur-assets/")).toBe("/anhur-assets/");
    expect(joinPublicAssetBase(undefined, "/anhur-assets/")).toBe(
      "/anhur-assets/",
    );
    expect(joinPublicAssetBase("./", "/anhur-assets/")).toBe("/anhur-assets/");
  });

  it("joins a nested Vite pathname without putting base on disk", () => {
    expect(joinPublicAssetBase("/blog/", "/anhur-assets/")).toBe(
      "/blog/anhur-assets/",
    );
  });

  it("does not double-prefix when assets.base already includes Vite base", () => {
    expect(joinPublicAssetBase("/blog/", "/blog/anhur-assets/")).toBe(
      "/blog/anhur-assets/",
    );
  });

  it("leaves a remote assets base unchanged", () => {
    expect(
      joinPublicAssetBase("/blog/", "https://cdn.example.com/media/"),
    ).toBe("https://cdn.example.com/media/");
    expect(joinPublicAssetBase("/blog/", "//cdn.example.com/media/")).toBe(
      "//cdn.example.com/media/",
    );
  });

  it("joins a remote Vite base onto a local assets path", () => {
    expect(
      joinPublicAssetBase("https://cdn.example.com/", "/anhur-assets/"),
    ).toBe("https://cdn.example.com/anhur-assets/");
    expect(
      joinPublicAssetBase("https://cdn.example.com/blog/", "/anhur-assets/"),
    ).toBe("https://cdn.example.com/blog/anhur-assets/");
  });
});

describe("resolvePublicAndLocalAssetBases", () => {
  it("keeps copy path without the Vite pathname", () => {
    expect(resolvePublicAndLocalAssetBases("/anhur-assets/", "/blog/")).toEqual(
      {
        publicBase: "/blog/anhur-assets/",
        localBase: "/anhur-assets/",
      },
    );
  });

  it("strips a Vite pathname the user already baked into assets.base", () => {
    expect(
      resolvePublicAndLocalAssetBases("/blog/anhur-assets/", "/blog/"),
    ).toEqual({
      publicBase: "/blog/anhur-assets/",
      localBase: "/anhur-assets/",
    });
  });

  it("does not copy remote configured bases", () => {
    expect(
      resolvePublicAndLocalAssetBases(
        "https://cdn.example.com/anhur/",
        "/blog/",
      ),
    ).toEqual({
      publicBase: "https://cdn.example.com/anhur/",
      localBase: undefined,
    });
  });

  it("still copies locally when only Vite base is a CDN origin", () => {
    expect(
      resolvePublicAndLocalAssetBases(
        "/anhur-assets/",
        "https://cdn.example.com/",
      ),
    ).toEqual({
      publicBase: "https://cdn.example.com/anhur-assets/",
      localBase: "/anhur-assets/",
    });
  });
});

describe("assetsOutDirSegment", () => {
  it("drops surrounding slashes for path.join(outDir, …)", () => {
    expect(assetsOutDirSegment("/anhur-assets/")).toBe("anhur-assets");
  });
});

describe("relativeAssetRequestPath", () => {
  it("matches the public Vite-prefixed URL", () => {
    expect(
      relativeAssetRequestPath("/blog/anhur-assets/cover.png", [
        "/blog/anhur-assets/",
        "/anhur-assets/",
      ]),
    ).toBe("/cover.png");
  });

  it("matches the local prefix after Vite strips base", () => {
    expect(
      relativeAssetRequestPath("/anhur-assets/cover.png", [
        "/blog/anhur-assets/",
        "/anhur-assets/",
      ]),
    ).toBe("/cover.png");
  });

  it("ignores query strings and remote prefixes", () => {
    expect(
      relativeAssetRequestPath("/anhur-assets/cover.png?v=1", [
        "https://cdn.example.com/anhur-assets/",
        "/anhur-assets/",
      ]),
    ).toBe("/cover.png");
  });

  it("returns null when no prefix matches", () => {
    expect(
      relativeAssetRequestPath("/other/cover.png", ["/anhur-assets/"]),
    ).toBeNull();
  });
});
