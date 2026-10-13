import { mkdir, readdir, symlink, utimes } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build, check, createAnhur, type AnhurSession } from "../../src/build";
import { COUNTING, count, makeOld, resetCounts } from "../fixtures/counting";
import { createProject, type TestProject } from "../fixtures/temp-project";

/** Values the test configs read (a config runs in the test process). */
// SAFETY: a global the test configs and this file agree on.
const knobs = globalThis as {
  anhurExcerpt?: number;
  anhurDates?: "date" | "datetime";
  anhurSuffix?: string;
  anhurStamp?: string;
  anhurAskerKey?: string;
};

const projects: TestProject[] = [];
const sessions: AnhurSession[] = [];
beforeEach(resetCounts);
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

/** Stored documents of a project, whatever the build mode. */
async function storedDocuments(dir: TestProject): Promise<string[]> {
  const names = await readdir(dir.path(".anhur/cache/documents"), {
    recursive: true,
  }).catch((): string[] => []);
  return names.filter((name) => name.endsWith(".json"));
}

/** One collection of notes with a counted, pure field. */
const NOTES = (extra = "") => `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { defineField } from "@anhur/core/plugin";
${COUNTING}
const upper = defineField(s.string(), {
  kind: "upper",
  whenAbsent: "skip",
  pure: true,
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
export default defineConfig({ content: [notes]${extra} });
`;

describe("a stored document is not reused when", () => {
  /** A config whose field reads a file through `addDependency`. */
  const WITH_DEPENDENCY = `
import { readFileSync } from "node:fs";
import path from "node:path";
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { defineField } from "@anhur/core/plugin";
const included = defineField(s.string(), {
  kind: "included",
  whenAbsent: "skip",
  pure: true,
  compile: (input, context) => {
    const file = path.resolve(path.dirname(context.document.filePath), String(input));
    context.addDependency(file);
    return readFileSync(file, "utf8").trim();
  },
});
const notes = defineCollection({
  name: "notes",
  directory: "notes",
  include: "*.md",
  schema: s.object({ text: included }),
});
export default defineConfig({ content: [notes] });
`;

  it("a file it read through addDependency changed (session and new session)", async () => {
    const dir = await project({
      "anhur.config.ts": WITH_DEPENDENCY,
      "notes/a.md": "---\ntext: ../parts/one.txt\n---\n",
      "parts/one.txt": "first\n",
    });
    await makeOld(dir, "notes/a.md", "parts/one.txt");
    const session = sessionFor(dir);
    await session.build();
    expect(await dir.read(".anhur/generated/allNotes.js")).toContain('"first"');

    await dir.write("parts/one.txt", "second\n");
    await session.build();
    expect(await dir.read(".anhur/generated/allNotes.js")).toContain(
      '"second"',
    );

    await dir.write("parts/one.txt", "third\n");
    await build({ rootDir: dir.dir });
    expect(await dir.read(".anhur/generated/allNotes.js")).toContain('"third"');
  });

  it("a file it read was replaced by one with the same size and time", async () => {
    // Failure: `cp -p`, `rsync -t` or a restore keeps size and mtime. Only
    // the inode and the change time tell.
    const dir = await project({
      "anhur.config.ts": WITH_DEPENDENCY,
      "notes/a.md": "---\ntext: ../parts/one.txt\n---\n",
      "parts/one.txt": "aaaa\n",
      "parts/other.txt": "bbbb\n",
    });
    const past = new Date(Date.now() - 60_000);
    await makeOld(dir, "notes/a.md", "parts/one.txt", "parts/other.txt");
    await build({ rootDir: dir.dir });
    await dir.write("parts/one.txt", "bbbb\n");
    await utimes(dir.path("parts/one.txt"), past, past);
    await build({ rootDir: dir.dir });
    expect(await dir.read(".anhur/generated/allNotes.js")).toContain('"bbbb"');
  });

  /** A config whose schema calls a helper of the package `name`. */
  const WITH_PACKAGE = (name: string) => `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { defineField } from "@anhur/core/plugin";
import { normalize } from "${name}";
${COUNTING}
const counted = defineField(s.string(), {
  kind: "counted",
  whenAbsent: "skip",
  pure: true,
  compile: (input) => {
    bump("compile");
    return String(input);
  },
});
const notes = defineCollection({
  name: "notes",
  directory: "notes",
  include: "*.md",
  schema: s.object({ kind: counted.transform((value) => normalize(value)) }),
});
export default defineConfig({ content: [notes] });
`;
  const packageJson = (name: string) =>
    JSON.stringify({ name, type: "module", exports: "./index.js" });
  const helper = (version: string) =>
    `export const normalize = (value) => value + "-${version}";\n`;

  // The two tests below count validations: a module that Node has loaded
  // stays loaded in this process, so the output cannot show the new helper
  // here. In a new process it does.
  it("a module the config imports through a linked package changed", async () => {
    // Failure: only `./` and `../` imports were followed. A workspace
    // package is reached through node_modules, and a helper a schema calls
    // looks the same from outside whatever it does.
    const dir = await project({
      "anhur.config.ts": WITH_PACKAGE("shared-schemas"),
      "notes/a.md": "---\nkind: guide\n---\n",
      "shared/package.json": packageJson("shared-schemas"),
      "shared/index.js": helper("v1"),
    });
    await mkdir(dir.path("node_modules"), { recursive: true });
    await symlink(
      dir.path("shared"),
      dir.path("node_modules/shared-schemas"),
      "dir",
    );
    await makeOld(dir, "notes/a.md");
    await build({ rootDir: dir.dir });
    resetCounts();
    await build({ rootDir: dir.dir });
    expect(count("compile")).toBe(0);
    await dir.write("shared/index.js", helper("v2"));
    await build({ rootDir: dir.dir });
    expect(count("compile")).toBe(1);

    // The same in one session: the config is loaded again.
    const session = sessionFor(dir);
    await session.build();
    resetCounts();
    await session.build();
    expect(count("compile")).toBe(0);
    await dir.write("shared/index.js", helper("v3"));
    await session.build();
    expect(count("compile")).toBe(1);
  });

  it("the entry file of an installed package the config imports changed", async () => {
    const dir = await project({
      "anhur.config.ts": WITH_PACKAGE("installed-schemas"),
      "notes/a.md": "---\nkind: guide\n---\n",
      "node_modules/installed-schemas/package.json":
        packageJson("installed-schemas"),
      "node_modules/installed-schemas/index.js": helper("v1"),
    });
    await makeOld(dir, "notes/a.md");
    await build({ rootDir: dir.dir });
    resetCounts();
    await build({ rootDir: dir.dir });
    expect(count("compile")).toBe(0);
    await dir.write("node_modules/installed-schemas/index.js", helper("v2"));
    await build({ rootDir: dir.dir });
    expect(count("compile")).toBe(1);
  });

  it("the lockfile changed", async () => {
    // Failure: an upgrade of a package deep in the tree (a remark plugin)
    // changes no file the config names.
    const dir = await project({
      "anhur.config.ts": NOTES(),
      "notes/a.md": "---\ntitle: a\n---\n",
      "package-lock.json": '{ "lockfileVersion": 3, "packages": {} }\n',
    });
    await makeOld(dir, "notes/a.md");
    await build({ rootDir: dir.dir });
    resetCounts();
    await build({ rootDir: dir.dir });
    expect(count("compile")).toBe(0);
    await dir.write(
      "package-lock.json",
      '{ "lockfileVersion": 3, "packages": { "node_modules/x": { "version": "2.0.0" } } }\n',
    );
    resetCounts();
    await build({ rootDir: dir.dir });
    expect(count("compile")).toBe(1);
  });

  // The options of a built-in field live in a closure: the function that
  // uses them has the same source for every option. Each test changes one
  // option through a global, so the config file stays the same.
  it("an option of s.excerpt() changed and the config file did not", async () => {
    const dir = await project({
      "anhur.config.ts": `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
const length = (globalThis as { anhurExcerpt?: number }).anhurExcerpt ?? 10;
const notes = defineCollection({
  name: "notes",
  directory: "notes",
  include: "*.md",
  schema: s.object({ title: s.string(), excerpt: s.excerpt({ length }) }),
});
export default defineConfig({ content: [notes] });
`,
      "notes/a.md": "---\ntitle: a\n---\nOne two three four five six seven.\n",
    });
    await makeOld(dir, "notes/a.md");
    try {
      knobs.anhurExcerpt = 10;
      await build({ rootDir: dir.dir });
      expect(await dir.read(".anhur/generated/allNotes.js")).not.toContain(
        "One two three four five",
      );
      knobs.anhurExcerpt = 30;
      await build({ rootDir: dir.dir });
      expect(await dir.read(".anhur/generated/allNotes.js")).toContain(
        "One two three four five",
      );
    } finally {
      delete knobs.anhurExcerpt;
    }
  });

  it("the output of s.isodate() changed and the config file did not", async () => {
    const dir = await project({
      "anhur.config.ts": `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
const output = (globalThis as { anhurDates?: "date" | "datetime" }).anhurDates;
const notes = defineCollection({
  name: "notes",
  directory: "notes",
  include: "*.md",
  schema: s.object({ when: s.isodate({ output }) }),
});
export default defineConfig({ content: [notes] });
`,
      "notes/a.md": "---\nwhen: 2024-05-01\n---\n",
    });
    await makeOld(dir, "notes/a.md");
    try {
      knobs.anhurDates = "datetime";
      await build({ rootDir: dir.dir });
      expect(await dir.read(".anhur/generated/allNotes.js")).toContain(
        '"when":"2024-05-01T00:00:00.000Z"',
      );
      knobs.anhurDates = "date";
      await build({ rootDir: dir.dir });
      expect(await dir.read(".anhur/generated/allNotes.js")).toContain(
        '"when":"2024-05-01"',
      );
    } finally {
      delete knobs.anhurDates;
    }
  });

  it("the key of a pure custom field changed", async () => {
    const dir = await project({
      "anhur.config.ts": `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { defineField, fingerprint } from "@anhur/core/plugin";
const suffix = (globalThis as { anhurSuffix?: string }).anhurSuffix ?? "";
const tagged = defineField(s.string(), {
  kind: "tagged",
  whenAbsent: "skip",
  pure: { key: fingerprint({ suffix }) },
  compile: (input) => String(input) + suffix,
});
const notes = defineCollection({ name: "notes", directory: "notes", include: "*.md", schema: s.object({ title: tagged }) });
export default defineConfig({ content: [notes] });
`,
      "notes/a.md": "---\ntitle: a\n---\n",
    });
    await makeOld(dir, "notes/a.md");
    try {
      knobs.anhurSuffix = "-one";
      await build({ rootDir: dir.dir });
      knobs.anhurSuffix = "-two";
      await build({ rootDir: dir.dir });
      expect(await dir.read(".anhur/generated/allNotes.js")).toContain(
        '"a-two"',
      );
    } finally {
      delete knobs.anhurSuffix;
    }
  });

  /** A loader for `.note` files that adds a value from outside the file. */
  const WITH_LOADER = (pure: string) => `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
const stamp = () => (globalThis as { anhurStamp?: string }).anhurStamp ?? "none";
const notes = defineCollection({
  name: "notes",
  directory: "notes",
  include: "*.note",
  schema: s.object({ title: s.string(), updated: s.string() }),
});
export default defineConfig({
  content: [notes],
  loaders: [{ name: "note", test: /\\.note$/,${pure} load: ({ raw }) => ({ data: { title: raw.trim(), updated: stamp() } }) }],
});
`;

  it("its loader does not say it is pure", async () => {
    // Failure: a loader that adds a git date or a value from a second file
    // ran in every session before; with the store it ran once.
    const dir = await project({
      "anhur.config.ts": WITH_LOADER(""),
      "notes/a.note": "A\n",
    });
    await makeOld(dir, "notes/a.note");
    try {
      knobs.anhurStamp = "one";
      const first = await build({ rootDir: dir.dir });
      expect(first.notStored).toEqual([
        {
          source: "notes",
          reason: 'the "note" loader of .note files is not pure',
        },
      ]);
      expect(await storedDocuments(dir)).toEqual([]);
      knobs.anhurStamp = "two";
      await build({ rootDir: dir.dir });
      expect(await dir.read(".anhur/generated/allNotes.js")).toContain('"two"');
    } finally {
      delete knobs.anhurStamp;
    }
  });

  it("stores the documents of a loader that says it is pure", async () => {
    const dir = await project({
      "anhur.config.ts": WITH_LOADER(" pure: true,"),
      "notes/a.note": "A\n",
    });
    const first = await build({ rootDir: dir.dir });
    expect(first.notStored).toEqual([]);
    expect(await storedDocuments(dir)).toHaveLength(1);
  });
});

describe("what the store keeps", () => {
  it("says why the documents of a source are not kept", async () => {
    const dir = await project({
      "anhur.config.ts": `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { defineField } from "@anhur/core/plugin";
const now = defineField(s.string(), { kind: "now", whenAbsent: "compile", compile: () => "x" });
const impure = defineCollection({ name: "impure", directory: "a", include: "*.md", schema: s.object({ now }) });
const clock = defineCollection({ name: "clock", directory: "b", include: "*.md", schema: s.object({ at: s.number().default(() => Math.random()) }) });
const off = defineCollection({ name: "off", directory: "c", include: "*.md", documentCache: false, schema: s.object({ title: s.string() }) });
const kept = defineCollection({ name: "kept", directory: "d", include: "*.md", schema: s.object({ title: s.string() }) });
export default defineConfig({ content: [impure, clock, off, kept] });
`,
      "a/x.md": "---\n---\n",
      "b/x.md": "---\n---\n",
      "c/x.md": "---\ntitle: c\n---\n",
      "d/x.md": "---\ntitle: d\n---\n",
    });
    const result = await build({ rootDir: dir.dir });
    expect(
      [...result.notStored].sort((a, b) => a.source.localeCompare(b.source)),
    ).toEqual([
      {
        source: "clock",
        reason:
          "the schema gives a new value on every read (a default such as () => new Date())",
      },
      {
        source: "impure",
        reason: 'the field "now" (now) is not pure and has no cache',
      },
    ]);
    // `off` asked for it and `kept` is stored: neither is reported.
    expect(await storedDocuments(dir)).toHaveLength(1);
  });

  it("keeps the documents of dev and build apart", async () => {
    // Failure: "vite dev", then "anhur build", then "vite dev" again made
    // every run a cold one: each mode replaced the documents of the other.
    const dir = await project({
      "anhur.config.ts": NOTES(),
      "notes/a.md": "---\ntitle: a\n---\n",
      "notes/b.md": "---\ntitle: b\n---\n",
    });
    await makeOld(dir, "notes/a.md", "notes/b.md");
    await build({ rootDir: dir.dir, mode: "dev" });
    await build({ rootDir: dir.dir, mode: "build" });
    expect(count("compile")).toBe(4);
    resetCounts();
    const dev = await build({ rootDir: dir.dir, mode: "dev" });
    const production = await build({ rootDir: dir.dir, mode: "build" });
    expect(count("compile")).toBe(0);
    expect(dev.reuse).toEqual({ unchanged: 2, compared: 0, validated: 0 });
    expect(production.reuse).toEqual({
      unchanged: 2,
      compared: 0,
      validated: 0,
    });
  });

  it("keeps the documents a dry run made when a build of the session follows", async () => {
    // Failure: a host that checks first and then builds with one session
    // left the next session cold.
    const dir = await project({
      "anhur.config.ts": NOTES(),
      "notes/a.md": "---\ntitle: a\n---\n",
    });
    const session = sessionFor(dir);
    await session.build({ dryRun: true });
    expect(await storedDocuments(dir)).toEqual([]);
    await session.build();
    expect(await storedDocuments(dir)).toHaveLength(1);
    resetCounts();
    await build({ rootDir: dir.dir });
    expect(count("compile")).toBe(0);
  });

  it("does not change the disk in a dry run, also for a damaged field cache entry", async () => {
    const dir = await project({
      "anhur.config.ts": `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
const notes = defineCollection({ name: "notes", directory: "notes", include: "*.md", schema: s.object({ title: s.string(), toc: s.toc() }) });
export default defineConfig({ content: [notes] });
`,
      "notes/a.md": "---\ntitle: a\n---\n# One\n",
    });
    await build({ rootDir: dir.dir });
    const fields = dir.path(".anhur/cache/fields");
    const listing = async () =>
      (await readdir(fields, { recursive: true })).sort();
    const before = await listing();
    const entry = before.find((name) => name.endsWith(".json"));
    if (entry === undefined) throw new Error("expected a field cache entry");
    await dir.write(path.join(".anhur/cache/fields", entry), "{ not json");
    // The stored document must not hide the damaged field entry.
    await dir.write("notes/a.md", "---\ntitle: a\n---\n# One\n\ntext\n");
    await check({ rootDir: dir.dir });
    expect(await listing()).toEqual(before);
    expect(await dir.read(path.join(".anhur/cache/fields", entry))).toBe(
      "{ not json",
    );
  });

  it("rejects a cache option that is not a boolean", async () => {
    // Failure: `documentCache: "false"` from a JS config meant "on".
    const dir = await project({
      "anhur.config.ts": NOTES().replace(
        'include: "*.md",',
        'include: "*.md",\n  // @ts-expect-error -- a wrong type on purpose\n  documentCache: "false",',
      ),
      "notes/a.md": "---\ntitle: a\n---\n",
    });
    await expect(build({ rootDir: dir.dir })).rejects.toThrow(
      /documentCache must be true or false/,
    );
  });
});

describe("shared work between fields", () => {
  it("is announced only by a field that compiles in this build", async () => {
    // Failure: a field asked isShared(), got `true` for a field whose value
    // came from the field cache, and then did the whole shared work alone.
    const dir = await project({
      "anhur.config.ts": `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { defineField } from "@anhur/core/plugin";
${COUNTING}
const maker = defineField(s.string(), {
  kind: "maker",
  whenAbsent: "skip",
  cache: { version: "1", key: () => "maker" },
  shares: () => ["work"],
  compile: (input, context) => context.share("work", () => { bump("work"); return String(input); }),
});
const asker = defineField(s.string(), {
  kind: "asker",
  whenAbsent: "compile",
  cache: { version: "1", key: () => (globalThis as { anhurAskerKey?: string }).anhurAskerKey ?? "a" },
  compile: (_input, context) => {
    bump(context.isShared("work") ? "shared" : "alone");
    return "x";
  },
});
const notes = defineCollection({ name: "notes", directory: "notes", include: "*.md", documentCache: false, schema: s.object({ title: maker, asker }) });
export default defineConfig({ content: [notes] });
`,
      "notes/a.md": "---\ntitle: a\n---\n",
    });
    try {
      await build({ rootDir: dir.dir });
      expect(count("shared")).toBe(1);
      expect(count("alone")).toBe(0);
      resetCounts();
      // `maker` now comes from the field cache; `asker` has a new key.
      knobs.anhurAskerKey = "b";
      await build({ rootDir: dir.dir });
      expect(count("work")).toBe(0);
      expect(count("shared")).toBe(0);
      expect(count("alone")).toBe(1);
    } finally {
      delete knobs.anhurAskerKey;
    }
  });
});
