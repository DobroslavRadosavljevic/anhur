import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Plugin } from "vite";
import { anhur } from "../../src/index";

const fixturesRoot = path.join(import.meta.dirname, "../fixtures");

describe("anhur vite plugin buildStart", () => {
  afterEach(async () => {
    await rm(path.join(fixturesRoot, "basic", ".anhur"), {
      recursive: true,
      force: true,
    });
  });

  it("generates content for a fixture project", async () => {
    const root = path.join(fixturesRoot, "basic");
    const plugin = anhur() as Plugin & {
      config: (config: { root?: string }) => void;
      buildStart: () => Promise<void>;
    };

    plugin.config({ root });
    await plugin.buildStart();

    const index = await readFile(
      path.join(root, ".anhur/generated/index.js"),
      "utf8",
    );
    expect(index).toContain("allPosts");
  });
});
