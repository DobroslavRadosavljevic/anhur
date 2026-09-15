import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Plugin } from "vite";
import { relativeAssetRequestPath } from "@anhur/core";
import { anhur, resolveServedAssetPath } from "../../src/index";

const fixturesRoot = path.join(import.meta.dirname, "../fixtures");

describe("anhur vite plugin", () => {
  it("exposes plugin name", () => {
    const plugin = anhur() as Plugin;
    expect(plugin.name).toBe("anhur");
  });

  it("aliases anhur/generated to .anhur/generated under root", async () => {
    const root = path.join(fixturesRoot, "basic");
    const plugin = anhur() as Plugin & {
      config: (config: { root?: string }) => Promise<Record<string, unknown>>;
    };

    const patch = await plugin.config({ root });

    expect(patch.resolve).toMatchObject({
      alias: {
        "anhur/generated": path.resolve(root, ".anhur/generated"),
      },
    });
    expect(patch.optimizeDeps).toMatchObject({
      exclude: ["anhur/generated"],
    });
  });
});

describe("resolveServedAssetPath", () => {
  const assetsDir = "/proj/.anhur/assets";

  it("resolves files inside the assets directory", () => {
    expect(resolveServedAssetPath(assetsDir, "/cover.png")).toBe(
      path.resolve(assetsDir, "cover.png"),
    );
  });

  it("rejects sibling directories that share a path prefix", () => {
    expect(
      resolveServedAssetPath(assetsDir, "/../assets.backup/secret.txt"),
    ).toBeNull();
  });

  it("rejects malformed percent-encoding", () => {
    expect(resolveServedAssetPath(assetsDir, "/%")).toBeNull();
  });
});

describe("relativeAssetRequestPath (Vite base)", () => {
  it("accepts both prefixed and stripped asset URLs", () => {
    const prefixes = ["/blog/anhur-assets/", "/anhur-assets/"];
    expect(
      relativeAssetRequestPath("/blog/anhur-assets/cover.png", prefixes),
    ).toBe("/cover.png");
    expect(relativeAssetRequestPath("/anhur-assets/cover.png", prefixes)).toBe(
      "/cover.png",
    );
  });
});
