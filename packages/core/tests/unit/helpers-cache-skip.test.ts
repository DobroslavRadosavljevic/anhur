import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPersistCache } from "../../src/persist-cache";
import { schema as s } from "../../src/schema";
import { createSkippedSignal, isSkippedSignal } from "../../src/skip";
import { Effect } from "effect";
import { createBuildContext } from "../../src/build-context";
import { defineConfig } from "../../src/config";
import { validateWithSchema } from "../../src/validate";

describe("s.isodate()", () => {
  it("parses to ISO string", () => {
    const result = s.isodate().parse("2026-08-05");
    expect(result).toBe(new Date("2026-08-05").toISOString());
  });

  it("coerces Date objects from YAML/gray-matter", () => {
    const result = s.isodate().parse(new Date("2026-08-01T00:00:00.000Z"));
    expect(result).toBe("2026-08-01T00:00:00.000Z");
  });

  it("accepts unquoted YAML dates from gray-matter", async () => {
    const { matterLoader } = await import("../../src/loaders/matter");
    const loaded = await matterLoader().load({
      path: "post.md",
      raw: `---
publishedAt: 2026-08-01
---

Body
`,
    });
    expect(loaded.data.publishedAt).toBeInstanceOf(Date);
    const iso = s.isodate().parse(loaded.data.publishedAt);
    expect(iso).toBe(new Date("2026-08-01").toISOString());
  });

  it("rejects invalid dates", () => {
    expect(() => s.isodate().parse("not-a-date")).toThrow();
  });
});

describe("s.excerpt / s.metadata / s.toc", () => {
  const schema = s.object({
    excerpt: s.excerpt({ length: 40 }),
    metadata: s.metadata(),
    toc: s.toc(),
  });
  const config = defineConfig({
    content: [
      {
        type: "collection",
        name: "posts",
        typeName: "Post",
        directory: "content",
        include: "**/*.md",
        schema,
      },
    ],
  });

  const body = `# Title

## Section

Hello **world** and more words for the excerpt.`;

  it("derives excerpt, metadata, and toc from body", async () => {
    const buildContext = await createBuildContext(config, {
      rootDir: "/tmp",
      configDir: "/tmp",
    });
    const data = await Effect.runPromise(
      validateWithSchema({
        schema,
        input: {},
        filePath: "/tmp/content/hello.md",
        id: "hello",
        content: body,
        config,
        buildContext,
        sourceName: "posts",
      }),
    );
    expect(data.excerpt.length).toBeLessThanOrEqual(41);
    expect(data.excerpt).toContain("Hello");
    expect(data.metadata.readingTime).toBeGreaterThanOrEqual(1);
    expect(data.metadata.wordCount).toBeGreaterThan(0);
    expect(data.toc[0]?.title).toBe("Title");
    expect(data.toc[0]?.items[0]?.title).toBe("Section");
  });
});

describe("skip signals", () => {
  it("marks and detects skipped transforms", () => {
    const signal = createSkippedSignal("draft");
    expect(isSkippedSignal(signal)).toBe(true);
    expect(signal.reason).toBe("draft");
    expect(isSkippedSignal({ draft: true })).toBe(false);
  });
});

describe("persist cache", () => {
  it("reuses computed values across instances", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "anhur-cache-"));
    try {
      let calls = 0;
      const compute = async () => {
        calls += 1;
        return { ok: true, n: calls };
      };

      const cache1 = await createPersistCache(dir);
      const first = await cache1.getOrCompute(
        "mdx:a",
        { source: "hi" },
        compute,
      );
      const second = await cache1.getOrCompute(
        "mdx:a",
        { source: "hi" },
        compute,
      );
      expect(first).toEqual({ ok: true, n: 1 });
      expect(second).toEqual({ ok: true, n: 1 });
      expect(calls).toBe(1);

      const cache2 = await createPersistCache(dir);
      const third = await cache2.getOrCompute(
        "mdx:a",
        { source: "hi" },
        compute,
      );
      expect(third).toEqual({ ok: true, n: 1 });
      expect(calls).toBe(1);

      const fourth = await cache2.getOrCompute(
        "mdx:a",
        { source: "changed" },
        compute,
      );
      expect(fourth).toEqual({ ok: true, n: 2 });
      expect(calls).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
