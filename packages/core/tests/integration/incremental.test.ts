import { readdir, rm, utimes } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  build,
  check,
  createAnhur,
  type AnhurSession,
  type BuildResult,
} from "../../src/build";
import { createProject, type TestProject } from "../fixtures/temp-project";

const projects: TestProject[] = [];
const sessions: AnhurSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const project of projects.splice(0)) await project.remove();
});

async function project(files: { readonly [file: string]: string }) {
  const created = await createProject(files);
  projects.push(created);
  return created;
}

function sessionFor(dir: TestProject): AnhurSession {
  const session = createAnhur({ rootDir: dir.dir });
  sessions.push(session);
  return session;
}

/** Counters the test configs below write to (the config runs in this process). */
type Counts = { [name: string]: number | undefined };
// SAFETY: a global the test configs and this file agree on.
const shared = globalThis as { anhurCounts?: Counts };
beforeEach(() => {
  shared.anhurCounts = {};
});
function count(name: string): number {
  return shared.anhurCounts?.[name] ?? 0;
}
function resetCounts(): void {
  shared.anhurCounts = {};
}

const COUNTING = `
const counts = ((globalThis as { anhurCounts?: Record<string, number> }).anhurCounts ??= {});
const bump = (name: string) => {
  const store = ((globalThis as { anhurCounts?: Record<string, number> }).anhurCounts ??= counts);
  store[name] = (store[name] ?? 0) + 1;
};
`;

/** Names of the files a build wrote, relative to the output folder. */
function written(result: BuildResult): string[] {
  return result.written
    .map((file) =>
      path.relative(result.outputDir, file).split(path.sep).join("/"),
    )
    .sort();
}

/**
 * Make a file look old, so its stat alone proves it unchanged (a file
 * written in the last seconds is read and hashed again instead).
 */
async function settle(dir: TestProject, ...files: string[]): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  for (const file of files) await utimes(dir.path(file), past, past);
}

const BLOG = `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
${COUNTING}
const authors = defineCollection({
  name: "authors",
  directory: "authors",
  include: "*.yml",
  schema: s.object({ name: s.string() }),
});
const posts = defineCollection({
  name: "posts",
  directory: "posts",
  include: "*.md",
  schema: s.object({ title: s.string(), author: s.reference("authors", { embed: true }) }),
  transform: (doc) => {
    bump("transform");
    return { ...doc, shout: doc.title.toUpperCase() };
  },
});
export default defineConfig({ content: [authors, posts] });
`;

describe("rebuilds in a session", () => {
  it("redo work only for the document that changed", async () => {
    const dir = await project({
      "anhur.config.ts": BLOG,
      "authors/ada.yml": "name: Ada\n",
      "authors/bob.yml": "name: Bob\n",
      "posts/a.md": "---\ntitle: A\nauthor: ada\n---\n",
      "posts/b.md": "---\ntitle: B\nauthor: bob\n---\n",
      "posts/c.md": "---\ntitle: C\nauthor: ada\n---\n",
    });
    const session = sessionFor(dir);
    const first = await session.build();
    expect(first.documentCount).toBe(5);
    expect(count("transform")).toBe(3);

    resetCounts();
    const again = await session.build();
    expect(again.written).toEqual([]);
    expect(again.removed).toEqual([]);
    expect(count("transform")).toBe(0);

    await dir.write("posts/b.md", "---\ntitle: B2\nauthor: bob\n---\n");
    resetCounts();
    const edited = await session.build();
    expect(count("transform")).toBe(1);
    const changed = written(edited);
    expect(changed).toContain("allPosts.js");
    expect(
      changed.filter((file) => file.startsWith("documents/posts/")),
    ).toHaveLength(1);
    expect(changed).not.toContain("allAuthors.js");
    expect(await dir.read(".anhur/generated/allPosts.js")).toContain(
      '"shout":"B2"',
    );
  });

  it("embed the new version of a document that others refer to", async () => {
    const dir = await project({
      "anhur.config.ts": BLOG,
      "authors/ada.yml": "name: Ada\n",
      "authors/bob.yml": "name: Bob\n",
      "posts/a.md": "---\ntitle: A\nauthor: ada\n---\n",
      "posts/b.md": "---\ntitle: B\nauthor: bob\n---\n",
    });
    const session = sessionFor(dir);
    await session.build();
    await dir.write("authors/ada.yml", "name: Ada Lovelace\n");
    resetCounts();
    const result = await session.build();
    // The post did not change, so its transform does not run again…
    expect(count("transform")).toBe(0);
    // …but the document embedded in it did.
    const list = await dir.read(".anhur/generated/allPosts.js");
    expect(list).toContain('"name":"Ada Lovelace"');
    expect(list).toContain('"name":"Bob"');
    expect(
      written(result).filter((file) => file.startsWith("documents/posts/")),
    ).toHaveLength(1);
  });

  it("report a reference that broke, and the fix, without a restart", async () => {
    const dir = await project({
      "anhur.config.ts": BLOG,
      "authors/ada.yml": "name: Ada\n",
      "posts/a.md": "---\ntitle: A\nauthor: ada\n---\n",
    });
    const session = sessionFor(dir);
    await session.build();
    await rm(dir.path("authors/ada.yml"));
    await expect(session.build()).rejects.toThrow(/No authors document/);
    // The same broken state is reported again, not remembered as fine.
    await expect(session.build()).rejects.toThrow(/No authors document/);
    await dir.write("authors/ada.yml", "name: Ada\n");
    const fixed = await session.build();
    expect(fixed.documentCount).toBe(2);
  });

  it("run a transform again when a source it read changed", async () => {
    const config = (cache: string) => `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
${COUNTING}
const tags = defineCollection({ name: "tags", directory: "tags", include: "*.yml", schema: s.object({ label: s.string() }) });
const posts = defineCollection({
  name: "posts",
  directory: "posts",
  include: "*.md",
  schema: s.object({ title: s.string() }),${cache}
  transform: (doc, ctx) => {
    bump("reader");
    return { ...doc, tagCount: ctx.documents(tags).length };
  },
});
const notes = defineCollection({
  name: "notes",
  directory: "notes",
  include: "*.md",
  schema: s.object({ title: s.string() }),
  transform: (doc) => {
    bump("plain");
    return doc;
  },
});
export default defineConfig({ content: [tags, posts, notes] });
`;
    const dir = await project({
      "anhur.config.ts": config(""),
      "tags/a.yml": "label: A\n",
      "posts/p.md": "---\ntitle: P\n---\n",
      "posts/q.md": "---\ntitle: Q\n---\n",
      "notes/n.md": "---\ntitle: N\n---\n",
    });
    const session = sessionFor(dir);
    await session.build();
    expect(count("reader")).toBe(2);
    expect(count("plain")).toBe(1);

    await dir.write("tags/b.yml", "label: B\n");
    resetCounts();
    await session.build();
    expect(count("reader")).toBe(2);
    expect(count("plain")).toBe(0);
    expect(await dir.read(".anhur/generated/allPosts.js")).toContain(
      '"tagCount":2',
    );

    // `transformCache: false`: every build runs the transform.
    await dir.write("anhur.config.ts", config("\n  transformCache: false,"));
    await session.build();
    resetCounts();
    await session.build();
    expect(count("reader")).toBe(2);
    expect(count("plain")).toBe(0);
  });

  it("write a generated file again when it was deleted", async () => {
    const dir = await project({
      "anhur.config.ts": BLOG,
      "authors/ada.yml": "name: Ada\n",
      "posts/a.md": "---\ntitle: A\nauthor: ada\n---\n",
    });
    const session = sessionFor(dir);
    await session.build();
    await rm(dir.path(".anhur/generated/allPosts.js"));
    const result = await session.build();
    expect(written(result)).toContain("allPosts.js");
    expect(await dir.read(".anhur/generated/allPosts.js")).toContain('"A"');
  });

  it("notice a file that changed without a new size or time", async () => {
    const dir = await project({
      "anhur.config.ts": BLOG,
      "authors/ada.yml": "name: Ada\n",
      "posts/a.md": "---\ntitle: A1\nauthor: ada\n---\n",
    });
    const session = sessionFor(dir);
    await session.build();
    // Same length, written right away: only the content tells.
    await dir.write("posts/a.md", "---\ntitle: A2\nauthor: ada\n---\n");
    await session.build();
    expect(await dir.read(".anhur/generated/allPosts.js")).toContain('"A2"');
  });
});

const FIELDS = (field: string) => `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { defineField } from "@anhur/core/plugin";
${COUNTING}
const upper = defineField(s.string(), {
  kind: "upper",
  whenAbsent: "skip",${field}
  compile: (input) => {
    bump("compile");
    return String(input).toUpperCase();
  },
});
const notes = defineCollection({
  name: "notes",
  directory: "notes",
  include: "*.md",
  schema: s.object({ title: upper }),
});
export default defineConfig({ content: [notes] });
`;

describe("document store", () => {
  it("lets a new session reuse validated documents until a file changes", async () => {
    const dir = await project({
      "anhur.config.ts": FIELDS("\n  pure: true,"),
      "notes/a.md": "---\ntitle: a\n---\n",
      "notes/b.md": "---\ntitle: b\n---\n",
    });
    await build({ rootDir: dir.dir });
    expect(count("compile")).toBe(2);
    expect(
      (await readdir(dir.path(".anhur/cache/documents"))).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(2);

    await settle(dir, "notes/a.md", "notes/b.md");
    resetCounts();
    const second = await build({ rootDir: dir.dir });
    expect(count("compile")).toBe(0);
    expect(second.written).toEqual([]);

    await dir.write("notes/a.md", "---\ntitle: changed\n---\n");
    resetCounts();
    await build({ rootDir: dir.dir });
    expect(count("compile")).toBe(1);
    expect(await dir.read(".anhur/generated/allNotes.js")).toContain(
      '"CHANGED"',
    );

    // A document that is gone leaves the store.
    await rm(dir.path("notes/b.md"));
    await build({ rootDir: dir.dir });
    expect(
      (await readdir(dir.path(".anhur/cache/documents"))).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(1);
  });

  it("compares content when only the time of a file changed", async () => {
    const dir = await project({
      "anhur.config.ts": FIELDS("\n  pure: true,"),
      "notes/a.md": "---\ntitle: a\n---\n",
    });
    await build({ rootDir: dir.dir });
    // A fresh checkout: same content, new timestamps.
    const later = new Date(Date.now() - 30_000);
    await utimes(dir.path("notes/a.md"), later, later);
    resetCounts();
    await build({ rootDir: dir.dir });
    expect(count("compile")).toBe(0);
  });

  it("does not keep documents with a field that is not pure", async () => {
    const dir = await project({
      "anhur.config.ts": FIELDS(""),
      "notes/a.md": "---\ntitle: a\n---\n",
    });
    await build({ rootDir: dir.dir });
    await settle(dir, "notes/a.md");
    resetCounts();
    await build({ rootDir: dir.dir });
    expect(count("compile")).toBe(1);
  });

  it("validates again when the config changed", async () => {
    const dir = await project({
      "anhur.config.ts": FIELDS("\n  pure: true,"),
      "notes/a.md": "---\ntitle: a\n---\n",
    });
    await build({ rootDir: dir.dir });
    await settle(dir, "notes/a.md");
    await dir.write(
      "anhur.config.ts",
      FIELDS("\n  pure: true,").replace("toUpperCase()", "toLowerCase()"),
    );
    resetCounts();
    await build({ rootDir: dir.dir });
    expect(count("compile")).toBe(1);
    expect(await dir.read(".anhur/generated/allNotes.js")).toContain('"a"');
  });

  it("is not written by check, and is off with cacheDir: false", async () => {
    const dir = await project({
      "anhur.config.ts": FIELDS("\n  pure: true,"),
      "notes/a.md": "---\ntitle: a\n---\n",
    });
    await check({ rootDir: dir.dir });
    expect(
      await readdir(dir.path(".anhur/cache/documents")).catch(() => []),
    ).toEqual([]);

    const off = await project({
      "anhur.config.ts": FIELDS("\n  pure: true,").replace(
        "content: [notes]",
        "content: [notes], cacheDir: false",
      ),
      "notes/a.md": "---\ntitle: a\n---\n",
    });
    await build({ rootDir: off.dir });
    expect(await readdir(off.path(".anhur")).catch(() => [])).not.toContain(
      "cache",
    );
  });
});

describe("field cache", () => {
  it("has the options of s.toc() in its key", async () => {
    const config = (maxDepth: number) => `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
const notes = defineCollection({
  name: "notes",
  directory: "notes",
  include: "*.md",
  schema: s.object({ toc: s.toc({ maxDepth: ${maxDepth} }) }),
});
export default defineConfig({ content: [notes] });
`;
    const dir = await project({
      "anhur.config.ts": config(3),
      "notes/a.md": "# One\n\n## Two\n\n### Three\n",
    });
    await build({ rootDir: dir.dir });
    expect(await dir.read(".anhur/generated/allNotes.js")).toContain("Three");
    await dir.write("anhur.config.ts", config(1));
    await build({ rootDir: dir.dir });
    const list = await dir.read(".anhur/generated/allNotes.js");
    expect(list).toContain("One");
    expect(list).not.toContain("Two");
  });
});

const THREADS = (workers: string) => `
import { threadId } from "node:worker_threads";
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { defineField } from "@anhur/core/plugin";
const where = defineField(s.number(), {
  kind: "where",
  whenAbsent: "compile",
  cache: { version: "1", key: () => "k" },
  compile: () => threadId,
});
const notes = defineCollection({
  name: "notes",
  directory: "notes",
  include: "*.md",
  schema: s.object({ title: s.string(), thread: where }),
});
export default defineConfig({ content: [notes]${workers} });
`;

describe("worker threads", () => {
  const files = (config: string) => {
    const all: { [file: string]: string } = { "anhur.config.ts": config };
    for (let index = 0; index < 150; index += 1) {
      all[`notes/n${index}.md`] = `---\ntitle: N${index}\n---\n`;
    }
    return all;
  };
  const threads = async (dir: TestProject): Promise<Set<number>> => {
    const list = await dir.read(".anhur/generated/allNotes.js");
    return new Set(
      [...list.matchAll(/"thread":(\d+)/g)].map((match) => Number(match[1])),
    );
  };

  it("validate many documents off the main thread, with the same result", async () => {
    const dir = await project(files(THREADS(", workers: 2")));
    const result = await build({ rootDir: dir.dir });
    expect(result.warnings).toEqual([]);
    expect(result.documentCount).toBe(150);
    const used = await threads(dir);
    expect(used.has(0)).toBe(false);
    expect(used.size).toBeGreaterThan(0);
    expect(used.size).toBeLessThanOrEqual(2);
    const list = await dir.read(".anhur/generated/allNotes.js");
    expect(list).toContain('"title":"N0"');
    expect(list).toContain('"title":"N149"');
  });

  it("stay off with workers: false, and report a document that fails in a worker", async () => {
    const off = await project(files(THREADS(", workers: false")));
    await build({ rootDir: off.dir });
    expect(await threads(off)).toEqual(new Set([0]));

    const broken = await project({
      ...files(THREADS(", workers: 2")),
      "notes/bad.md": "---\ntitle: [not, a, string]\n---\n",
    });
    await expect(build({ rootDir: broken.dir })).rejects.toThrow(
      /notes\/bad\.md/,
    );
  });
});
