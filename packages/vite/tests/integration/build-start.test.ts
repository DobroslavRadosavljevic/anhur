import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Plugin } from "vite";
import { anhur } from "../../src/index";

const fixturesRoot = path.join(import.meta.dirname, "../fixtures");

function hasBuildHooks<T>(plugin: T): plugin is T &
  Plugin & {
    config: (
      config: { root?: string },
      env: { command: "serve" | "build"; mode: string },
    ) => void | Promise<void>;
    buildStart: () => Promise<void>;
  } {
  return (
    typeof plugin === "object" &&
    plugin !== null &&
    "config" in plugin &&
    typeof plugin.config === "function" &&
    "buildStart" in plugin &&
    typeof plugin.buildStart === "function"
  );
}

describe("anhur vite plugin buildStart", () => {
  afterEach(async () => {
    await rm(path.join(fixturesRoot, "basic", ".anhur"), {
      recursive: true,
      force: true,
    });
  });

  it("generates content for a fixture project", async () => {
    const root = path.join(fixturesRoot, "basic");
    const plugin = anhur();
    if (!hasBuildHooks(plugin)) {
      throw new Error("expected config and buildStart hooks");
    }

    plugin.config({ root }, { command: "build", mode: "production" });
    await plugin.buildStart();

    const index = await readFile(
      path.join(root, ".anhur/generated/index.js"),
      "utf8",
    );
    expect(index).toContain("allPosts");
  });
});
