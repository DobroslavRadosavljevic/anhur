import { chmod, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentFields, DocumentValue } from "../../src/document";
import { compileGlob, listContentFiles } from "../../src/engine/content-files";
import { copyData } from "../../src/engine/copy-data";
import {
  isSettled,
  mapPool,
  provesUnchanged,
  type FileSignature,
} from "../../src/engine/file-signature";
import { deepFreeze } from "../../src/engine/freeze";
import { findNonPlainData } from "../../src/engine/plain-data";
import { toJsLiteral } from "../../src/engine/serialize";
import { truncateText } from "../../src/schema/text";
import { createProject, type TestProject } from "../fixtures/temp-project";

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

describe("compileGlob", () => {
  const paths = [
    "a.md",
    "a.mdx",
    "b.json",
    "index.md",
    "index.yml",
    "a.b.md",
    "ab.md",
    "a1.md",
    "x1.md",
    "posts/a.md",
    "posts/b.mdx",
    "posts/2024/a.md",
    "posts/2024/deep/a.md",
    "drafts/a.md",
    "posts/drafts/a.md",
    "a/b",
    "a/b/c",
    "a",
    "sub/index.md",
    "a-b_c.d e.md",
  ];
  const patterns = [
    "**/*.md",
    "**/*.{md,mdx}",
    "*.md",
    "*.{md,mdx,json}",
    "index.{md,mdx,yml,yaml,json}",
    "posts/**/*.md",
    "posts/**",
    "**/drafts/**",
    "drafts/**",
    "**",
    "*",
    "*/*",
    "?.md",
    "a[0-9].md",
    "a[!0-9].md",
    "posts/*/a.md",
    "**/**/*.md",
    "posts/**/deep/*.md",
    "{posts,drafts}/*.md",
    "**/{a,b}.{md,mdx}",
  ];

  // The runtime's own matcher agrees on these plain patterns. Patterns on
  // which the runtimes differ are in content-files.test.ts.
  it("matches like path.matchesGlob", () => {
    for (const pattern of patterns) {
      const matches = compileGlob(pattern);
      for (const file of paths) {
        expect(matches(file), `${pattern} ~ ${file}`).toBe(
          path.matchesGlob(file, pattern),
        );
      }
    }
  });

  it("reads ./ at the start of a pattern like fs.glob does", () => {
    const matches = compileGlob("./posts/**/*.md");
    expect(matches("posts/a.md")).toBe(true);
    expect(matches("posts/2024/a.md")).toBe(true);
    expect(matches("a.md")).toBe(false);
  });

  it("needs one name or more after a trailing **", () => {
    const matches = compileGlob("posts/**");
    expect(matches("posts")).toBe(false);
    expect(matches("posts/a.md")).toBe(true);
    expect(matches("posts/2024/a.md")).toBe(true);
  });
});

describe("listContentFiles", () => {
  it("lists matching files, without dot-folders, node_modules, excluded and skipped folders", async () => {
    const project = await createProject({
      "content/a.md": "",
      "content/b.txt": "",
      "content/2024/c.md": "",
      "content/.hidden/d.md": "",
      "content/.e.md": "",
      "content/node_modules/pkg/f.md": "",
      "content/drafts/g.md": "",
      "content/out/h.md": "",
      "elsewhere/real.md": "",
    });
    projects.push(project);
    const root = project.path("content");
    await symlink(
      project.path("elsewhere/real.md"),
      path.join(root, "link.md"),
    );
    await symlink(project.path("elsewhere"), path.join(root, "linked-folder"));
    const files = await listContentFiles(root, {
      include: ["**/*.md"],
      exclude: ["drafts/**"],
      skip: [path.join(root, "out")],
    });
    expect(files.map((file) => file.relative)).toEqual([
      "2024/c.md",
      "a.md",
      "link.md",
    ]);
    expect(files[0]?.absolute).toBe(path.join(root, "2024", "c.md"));
  });

  it("enters a linked folder a literal segment names, not through * or **", async () => {
    const project = await createProject({
      "content/a.md": "",
      "shared/guide.md": "",
      "shared/deep/more.md": "",
    });
    projects.push(project);
    const root = project.path("content");
    await symlink(project.path("shared"), path.join(root, "guides"));
    const list = async (include: string[]) =>
      (await listContentFiles(root, { include, exclude: [], skip: [] })).map(
        (file) => file.relative,
      );
    expect(await list(["**/*.md"])).toEqual(["a.md"]);
    expect(await list(["guides/*.md"])).toEqual(["guides/guide.md"]);
    expect(await list(["*/*.md"])).toEqual([]);
    expect(await list(["**/*"])).toEqual(["a.md"]);
    expect(await list(["**/guides/*.md"])).toEqual(["guides/guide.md"]);
    expect(await list(["./guides/**/*.md"])).toEqual([
      "guides/deep/more.md",
      "guides/guide.md",
    ]);
  });

  it("skips a folder below the root that cannot be read and tells the caller", async () => {
    // A user with every permission (root in a container) can read it anyway.
    if (process.getuid?.() === 0) return;
    const project = await createProject({
      "content/a.md": "",
      "content/locked/b.md": "",
    });
    projects.push(project);
    await chmod(project.path("content/locked"), 0o000);
    try {
      const skipped: string[] = [];
      const files = await listContentFiles(project.path("content"), {
        include: ["**/*.md"],
        exclude: [],
        skip: [],
        onSkip: (folder) => void skipped.push(folder),
      });
      expect(files.map((file) => file.relative)).toEqual(["a.md"]);
      expect(skipped).toEqual([project.path("content/locked")]);
    } finally {
      await chmod(project.path("content/locked"), 0o755);
    }
  });

  it("rejects when the folder cannot be read", async () => {
    const project = await createProject({ "content/a.md": "" });
    projects.push(project);
    await expect(
      listContentFiles(project.path("missing"), {
        include: ["**/*.md"],
        exclude: [],
        skip: [],
      }),
    ).rejects.toThrow();
  });
});

describe("file signatures", () => {
  const signature = (mtimeMs: number, size = 10): FileSignature => ({
    size,
    mtimeMs,
    ctimeMs: mtimeMs,
    ino: 1,
    isFile: true,
  });

  it("trusts an unchanged signature only when the file was not just modified", () => {
    const readAt = 100_000;
    // Modified long before it was read: a later change would show.
    expect(provesUnchanged(signature(50_000), signature(50_000), readAt)).toBe(
      true,
    );
    // Modified in the moment it was read: a second change in the same time
    // step would keep size and mtime.
    expect(provesUnchanged(signature(99_900), signature(99_900), readAt)).toBe(
      false,
    );
    expect(isSettled(99_900, readAt)).toBe(false);
    expect(
      provesUnchanged(signature(50_000), signature(50_000, 11), readAt),
    ).toBe(false);
    expect(provesUnchanged(signature(50_000), signature(60_000), readAt)).toBe(
      false,
    );
  });

  it("mapPool keeps order, limits concurrency and rethrows the first failure", async () => {
    let running = 0;
    let most = 0;
    const results = await mapPool([1, 2, 3, 4, 5, 6], 2, async (item) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return item * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
    expect(most).toBe(2);
    await expect(
      mapPool([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("two");
        return item;
      }),
    ).rejects.toThrow("two");
  });
});

describe("copyData", () => {
  it("copies like structuredClone, unfrozen, and shares nothing mutable", () => {
    const shared = { n: 1 };
    const source = deepFreeze({
      text: "body",
      when: new Date(5),
      list: [1, { a: 2 }, [3]],
      map: new Map<string, { v: number }>([["k", { v: 1 }]]),
      set: new Set([1, 2]),
      big: 5n,
      nothing: undefined,
      nil: null,
      first: shared,
      second: shared,
    });
    const copy = copyData(source);
    expect(copy).toEqual(structuredClone(source));
    expect(Object.isFrozen(copy)).toBe(false);
    expect(Object.isFrozen(copy.list)).toBe(false);
    expect(copy.first).toBe(copy.second);
    expect(copy.first).not.toBe(shared);
    copy.list.push(4);
    copy.map.set("x", { v: 2 });
    copy.when.setTime(6);
    expect(source.list).toHaveLength(3);
    expect(source.map.size).toBe(1);
    expect(source.when.getTime()).toBe(5);
  });

  it("keeps cycles, holes and a __proto__ key", () => {
    const items: DocumentValue[] = [];
    items.length = 3;
    items[1] = "x";
    const cycle: DocumentFields = { items };
    cycle.self = cycle;
    const copy = copyData(cycle);
    expect(copy.self).toBe(copy);
    expect(copy).not.toBe(cycle);
    const copied = copy.items;
    expect(copied).toHaveLength(3);
    expect(Array.isArray(copied) && 1 in copied).toBe(true);
    expect(Array.isArray(copied) && 0 in copied).toBe(false);

    const odd: DocumentFields = { a: 1 };
    Object.defineProperty(odd, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const safe = copyData(odd);
    expect(Object.keys(safe).sort()).toEqual(["__proto__", "a"]);
    expect(Object.getPrototypeOf(safe)).toBe(Object.prototype);
  });
});

describe("truncateText", () => {
  it("returns short text as is and cuts long text with an ellipsis", () => {
    expect(truncateText("short", 10)).toBe("short");
    expect(truncateText("exact", 5)).toBe("exact");
    expect(truncateText("one two three four", 9)).toBe("one two…");
    expect(truncateText("abcdef", 1)).toBe("…");
    expect(truncateText("a", 1)).toBe("a");
    expect(truncateText("abc", 0)).toBe("");
  });

  it("counts graphemes, not code units", () => {
    const family = "👨‍👩‍👧";
    // Three graphemes, far more code units: nothing to cut.
    expect(truncateText(`${family}${family}${family}`, 3)).toBe(
      `${family}${family}${family}`,
    );
    expect(truncateText(`${family}${family}${family}`, 2)).toBe(`${family}…`);
    expect(truncateText("ééé", 2)).toBe("é…");
  });

  it("only looks at the start of a long text", () => {
    // Counts the graphemes the segmenter hands out.
    const segment = Intl.Segmenter.prototype.segment;
    let pulled = 0;
    const spy = vi
      .spyOn(Intl.Segmenter.prototype, "segment")
      .mockImplementation(function (this: Intl.Segmenter, input: string) {
        const segments = segment.call(this, input);
        return {
          containing: (index?: number) => segments.containing(index),
          *[Symbol.iterator](): Generator<Intl.SegmentData, undefined> {
            for (const one of segments) {
              pulled += 1;
              yield one;
            }
            return undefined;
          },
        };
      });
    try {
      const long = "word ".repeat(200_000);
      expect(truncateText(long, 20)).toBe("word word word word…");
      expect(pulled).toBeLessThanOrEqual(21);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("findNonPlainData", () => {
  it("still finds problems with their path after the quick check", () => {
    expect(findNonPlainData({ a: [1, { b: () => 1 }] })).toMatchObject({
      fieldPath: ["a", 1, "b"],
    });
    expect(findNonPlainData({ a: new URL("https://x.y") })).toMatchObject({
      fieldPath: ["a"],
    });
    expect(findNonPlainData({ a: [1, "x", new Date(1), new Map()] })).toBe(
      undefined,
    );
  });

  it("does little work for a value that points at itself more than once", () => {
    // Eight links to itself: a walk that follows each of them at every
    // level visits 8^64 objects.
    let visits = 0;
    const fields: DocumentFields = {};
    const knot: DocumentFields = new Proxy(fields, {
      ownKeys: (target) => {
        visits += 1;
        return Reflect.ownKeys(target);
      },
    });
    for (let index = 0; index < 8; index += 1) fields[`self${index}`] = knot;
    expect(findNonPlainData(knot)).toMatchObject({
      message: "contains a circular reference",
    });
    expect(visits).toBeLessThan(1000);
  });
});

describe("toJsLiteral", () => {
  it("writes a frozen document once and an unfrozen one every time", () => {
    const meta = { id: "a" };
    const frozen = deepFreeze({ title: "A", _meta: meta });
    expect(toJsLiteral({ items: [frozen, frozen] })).toEqual({
      ok: true,
      code: '{"items":[{"title":"A","_meta":{"id":"a"}},{"title":"A","_meta":{"id":"a"}}]}',
    });
    const open = { title: "A", _meta: meta };
    expect(toJsLiteral(open)).toMatchObject({
      code: '{"title":"A","_meta":{"id":"a"}}',
    });
    open.title = "B";
    expect(toJsLiteral(open)).toMatchObject({
      code: '{"title":"B","_meta":{"id":"a"}}',
    });
  });

  it("reports the path of a problem deep in the value", () => {
    expect(toJsLiteral({ a: { b: [1, { c: () => 1 }] } })).toMatchObject({
      ok: false,
      fieldPath: ["a", "b", 1, "c"],
    });
    const map = new Map([["k", { bad: Symbol("x") }]]);
    expect(toJsLiteral({ map })).toMatchObject({
      ok: false,
      fieldPath: ["map", 0, 1, "bad"],
    });
  });
});
