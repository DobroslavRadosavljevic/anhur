import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Plugin } from "vite";
import { anhur } from "../../src/index";

const fixturesRoot = path.join(import.meta.dirname, "../fixtures");

describe("anhur vite plugin", () => {
  it("exposes plugin name", () => {
    const plugin = anhur() as Plugin;
    expect(plugin.name).toBe("anhur");
  });

  it("aliases anhur/generated to .anhur/generated under root", () => {
    const root = path.join(fixturesRoot, "basic");
    const plugin = anhur() as Plugin & {
      config: (config: { root?: string }) => Record<string, unknown>;
    };

    const patch = plugin.config({ root });

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
