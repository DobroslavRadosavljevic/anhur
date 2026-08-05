import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../../src/build";
import { formatAnhurError } from "../../src/errors";

const fixturesRoot = path.join(import.meta.dirname, "../fixtures");

describe("build", () => {
  afterEach(async () => {
    for (const name of [
      "localized",
      "missing-default-locale",
      "yaml-authors",
      "unique-ok",
      "unique-conflict",
      "codegen-split",
      "codegen-generate",
    ]) {
      await rm(path.join(fixturesRoot, name, ".anhur"), {
        recursive: true,
        force: true,
      });
    }
  });

  it("collects localized collection and singleton into .anhur/generated", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, "localized"),
    });

    expect(result.built).toHaveLength(2);
    const posts = result.built.find((b) => b.source.name === "posts");
    expect(posts?.documents).toHaveLength(2);

    const generatedPosts = (
      await import(
        `${pathToFileURL(path.join(result.outputDir, "allPosts.js")).href}?t=${Date.now()}`
      )
    ).default as Array<{ title: string; _meta: { locale?: string } }>;

    expect(generatedPosts.find((p) => p._meta.locale === "en")?.title).toBe(
      "Hello EN",
    );
  });

  it("collects YAML collection documents", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, "yaml-authors"),
    });

    expect(result.built[0]!.documents).toHaveLength(2);
  });

  it("allows the same unique slug across locales by default", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, "unique-ok"),
    });
    expect(result.built[0]!.documents).toHaveLength(2);
  });

  it("fails when unique slug conflicts in the same locale", async () => {
    await expect(
      build({
        rootDir: path.join(fixturesRoot, "unique-conflict"),
      }),
    ).rejects.toSatisfy((error) =>
      formatAnhurError(error).includes("duplicate"),
    );
  });

  it("fails when default-locale singleton is missing", async () => {
    await expect(
      build({
        rootDir: path.join(fixturesRoot, "missing-default-locale"),
      }),
    ).rejects.toSatisfy((error) =>
      formatAnhurError(error).includes("settings"),
    );
  });
});
