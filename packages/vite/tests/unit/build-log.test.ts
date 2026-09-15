import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BuildResult } from "@anhur/core";
import { formatAnhurBuildLog } from "../../src/build-log";

function isBuildResult<T>(value: T): value is T & BuildResult {
  return typeof value === "object" && value !== null && "built" in value;
}

function fakeResult(
  sources: Array<{ name: string; ids: string[]; locales?: string[] }>,
  outputDir: string,
): BuildResult {
  const fixture = {
    outputDir,
    configPath: path.join(path.dirname(outputDir), "..", "anhur.config.ts"),
    config: { content: [] },
    emittedAssetSources: [],
    built: sources.map((source) => ({
      source: {
        type: "collection" as const,
        name: source.name,
      },
      documents: source.ids.map((id, index) => ({
        data: {},
        _meta: {
          id,
          filePath: `/x/${id}.md`,
          relativePath: `${id}.md`,
          extension: ".md",
          locale: source.locales?.[index],
        },
      })),
    })),
  };
  if (!isBuildResult(fixture)) {
    throw new Error("expected BuildResult fixture");
  }
  return fixture;
}

describe("formatAnhurBuildLog", () => {
  it("summarizes totals and per-source document ids", () => {
    const result = fakeResult(
      [
        { name: "posts", ids: ["hello", "world"], locales: ["en", "de"] },
        { name: "authors", ids: ["ada"] },
      ],
      "/proj/.anhur/generated",
    );

    const lines = formatAnhurBuildLog(result, "built", {
      rootDir: "/proj",
    });

    expect(lines[0]).toBe("[anhur] built 3 document(s) → .anhur/generated");
    expect(lines[1]).toBe("[anhur]   posts (2): en/hello, de/world");
    expect(lines[2]).toBe("[anhur]   authors (1): ada");
  });

  it("uses rebuilt wording and handles empty sources", () => {
    const result = fakeResult([{ name: "pages", ids: [] }], "/out");
    const lines = formatAnhurBuildLog(result, "rebuilt");
    expect(lines[0]).toContain("rebuilt 0 document(s)");
    expect(lines[1]).toBe("[anhur]   pages (0): (none)");
  });

  it("truncates long id lists", () => {
    const ids = Array.from({ length: 45 }, (_, i) => `doc-${i}`);
    const result = fakeResult([{ name: "posts", ids }], "/out");
    const lines = formatAnhurBuildLog(result, "built");
    expect(lines[1]).toContain("… +5 more");
    expect(lines[1]).toContain("posts (45):");
  });

  it("keeps absolute output when rootDir is omitted", () => {
    const result = fakeResult(
      [{ name: "x", ids: ["a"] }],
      path.resolve("/abs/out"),
    );
    const lines = formatAnhurBuildLog(result, "built");
    expect(lines[0]).toContain(path.resolve("/abs/out"));
  });

  it("lists asset storage keys when present", () => {
    const result = fakeResult([{ name: "posts", ids: ["hello"] }], "/out");
    result.assetsStorage = {
      uploaded: ["anhur/new.png"],
      skipped: ["anhur/old.png"],
      deleted: ["anhur/gone.png"],
      dryRun: false,
    };

    const lines = formatAnhurBuildLog(result, "built");
    expect(lines).toContain(
      "[anhur]   assets storage: 1 uploaded, 1 skipped, 1 deleted",
    );
    expect(lines).toContain("[anhur]     uploaded (1): anhur/new.png");
    expect(lines).toContain("[anhur]     skipped (1): anhur/old.png");
    expect(lines).toContain("[anhur]     deleted (1): anhur/gone.png");
  });
});
