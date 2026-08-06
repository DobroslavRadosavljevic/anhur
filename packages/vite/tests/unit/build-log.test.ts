import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BuildResult } from "@anhur/core";
import { formatAnhurBuildLog } from "../../src/build-log";

function fakeResult(
  sources: Array<{ name: string; ids: string[]; locales?: string[] }>,
  outputDir: string,
): BuildResult {
  return {
    outputDir,
    configPath: path.join(path.dirname(outputDir), "..", "anhur.config.ts"),
    config: { content: [] } as BuildResult["config"],
    built: sources.map((source) => ({
      source: {
        type: "collection",
        name: source.name,
      } as BuildResult["built"][number]["source"],
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
});
