import { utimes } from "node:fs/promises";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { check, createAnhur, type AnhurSession } from "../../src/build";
import { Engine } from "../../src/engine/engine.service";
import { AnhurLive } from "../../src/engine/live";
import { failedTimingsOf } from "../../src/engine/result";
import {
  createProject,
  PNG_1X1,
  type TestProject,
} from "../fixtures/temp-project";

/**
 * A stage does its work again for a document that is a new object. So a
 * transform or `prepare` that runs again and gives the same data must give
 * the same document object, or every later stage (and every plugin that
 * compares by identity) redoes the whole site on each build.
 */

const projects: TestProject[] = [];
const sessions: AnhurSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const project of projects.splice(0)) await project.remove();
});

async function sessionWith(files: {
  readonly [file: string]: string | Uint8Array;
}) {
  const dir = await createProject(files);
  projects.push(dir);
  const session = createAnhur({ rootDir: dir.dir });
  sessions.push(session);
  return { dir, session };
}

/** What the test configs below count and read (the config runs in this process). */
type Probe = {
  counts: { [name: string]: number | undefined };
  /** Values a test sets for the callbacks of its config. */
  values: { [name: string]: string | undefined };
  /** The documents the `spy` plugin got in the last build. */
  documents: readonly unknown[];
};
// SAFETY: a global the test configs and this file agree on.
const shared = globalThis as { anhurProbe?: Probe };
function probe(): Probe {
  shared.anhurProbe ??= { counts: {}, values: {}, documents: [] };
  return shared.anhurProbe;
}
beforeEach(() => {
  shared.anhurProbe = undefined;
});
function count(name: string): number {
  return probe().counts[name] ?? 0;
}
function resetCounts(): void {
  probe().counts = {};
}

const PROBE = `
import { definePlugin } from "@anhur/core/plugin";
const probe = () =>
  ((globalThis as { anhurProbe?: any }).anhurProbe ??= { counts: {}, values: {}, documents: [] });
const bump = (name: string) => {
  const counts = probe().counts;
  counts[name] = (counts[name] ?? 0) + 1;
};
const value = (name: string): string | undefined => probe().values[name];
/** Counts the documents that are the same objects as in the build before. */
const spy = definePlugin({
  name: "spy",
  generate: (ctx) => {
    const documents = ctx.sources.flatMap((source) => source.documents);
    const before = new Set(probe().documents);
    probe().counts.same = documents.filter((document) => before.has(document)).length;
    probe().documents = documents;
  },
});
`;

/** Three posts with a transform, a view over them, and the `spy` plugin. */
const blog = (options: { collection?: string; config?: string }) => `
import { defineCollection, defineConfig, defineView, schema as s } from "@anhur/core";
${PROBE}
const posts = defineCollection({
  name: "posts",
  directory: "posts",
  include: "*.yml",
  schema: s.object({ title: s.string() }),${options.collection ?? ""}
  transform: (doc, ctx) => {
    bump("transform");
    if (value("skip") === doc.title) return ctx.skip();
    return { ...doc, shout: doc.title.toUpperCase(), stamp: value("stamp") ?? "none" };
  },
});
const all = defineView({
  name: "all",
  from: posts,
  where: () => {
    bump("where");
    return true;
  },
});
export default defineConfig({
  content: [posts],
  views: [all],
  plugins: [spy],
  cacheDir: false,
  workers: false,${options.config ?? ""}
});
`;

const POSTS = {
  "posts/a.yml": "title: a\n",
  "posts/b.yml": "title: b\n",
  "posts/c.yml": "title: c\n",
};

describe("documents that are made again with the same data", () => {
  it("stay the same objects when prepare changes nothing", async () => {
    const { session } = await sessionWith({
      "anhur.config.ts": blog({
        config: `
  prepare: () => {
    bump("prepare");
  },`,
      }),
      ...POSTS,
    });
    await session.build();
    expect(count("where")).toBe(3);

    resetCounts();
    const again = await session.build();
    expect(again.written).toEqual([]);
    // The hook still runs on every build.
    expect(count("prepare")).toBe(1);
    expect(count("same")).toBe(3);
    expect(count("where")).toBe(0);
  });

  it("stay the same objects when prepare makes the same change, and change with it", async () => {
    const { dir, session } = await sessionWith({
      "anhur.config.ts": blog({
        config: `
  prepare: (sources) => {
    bump("prepare");
    for (const source of sources) {
      for (const document of source.documents) document.label = value("label") ?? "none";
    }
  },`,
      }),
      ...POSTS,
    });
    probe().values.label = "one";
    await session.build();
    expect(await dir.read(".anhur/generated/allPosts.js")).toContain(
      '"label":"one"',
    );

    resetCounts();
    await session.build();
    expect(count("prepare")).toBe(1);
    expect(count("same")).toBe(3);
    expect(count("where")).toBe(0);

    probe().values.label = "two";
    resetCounts();
    await session.build();
    expect(count("same")).toBe(0);
    expect(count("where")).toBe(3);
    const output = await dir.read(".anhur/generated/allPosts.js");
    expect(output).toContain('"label":"two"');
    expect(output).not.toContain('"label":"one"');

    // Back to the first value: not the documents of the first build (they
    // are forgotten), but the right data.
    probe().values.label = "one";
    await session.build();
    expect(await dir.read(".anhur/generated/allPosts.js")).toContain(
      '"label":"one"',
    );
  });

  it("stay the same objects with transformCache: false, and change with the transform", async () => {
    const { dir, session } = await sessionWith({
      "anhur.config.ts": blog({
        collection: "\n  transformCache: false,",
      }),
      ...POSTS,
    });
    await session.build();

    resetCounts();
    const again = await session.build();
    expect(again.written).toEqual([]);
    // The transform still runs for every document on every build.
    expect(count("transform")).toBe(3);
    expect(count("same")).toBe(3);
    expect(count("where")).toBe(0);

    probe().values.stamp = "new";
    resetCounts();
    await session.build();
    expect(count("transform")).toBe(3);
    expect(count("same")).toBe(0);
    expect(count("where")).toBe(3);
    expect(await dir.read(".anhur/generated/allPosts.js")).toContain(
      '"stamp":"new"',
    );

    // A document the transform now skips is gone; the others stay.
    probe().values.skip = "b";
    resetCounts();
    const skipped = await session.build();
    expect(skipped.documentCount).toBe(2);
    expect(count("same")).toBe(2);
    expect(await dir.read(".anhur/generated/allPosts.js")).not.toContain(
      '"title":"b"',
    );
  });

  it("stay the same objects when a transform runs again for a source it read", async () => {
    const { dir, session } = await sessionWith({
      "anhur.config.ts": `
import { defineCollection, defineConfig, defineView, schema as s } from "@anhur/core";
${PROBE}
const tags = defineCollection({
  name: "tags",
  directory: "tags",
  include: "*.yml",
  schema: s.object({ label: s.string() }),
});
const posts = defineCollection({
  name: "posts",
  directory: "posts",
  include: "*.yml",
  schema: s.object({ title: s.string() }),
  transform: (doc, ctx) => {
    bump("transform");
    return { ...doc, tags: ctx.documents(tags).map((tag) => tag.label.length) };
  },
});
const all = defineView({
  name: "all",
  from: posts,
  where: () => {
    bump("where");
    return true;
  },
});
export default defineConfig({ content: [tags, posts], views: [all], plugins: [spy], cacheDir: false, workers: false });
`,
      "tags/t.yml": "label: one\n",
      ...POSTS,
    });
    await session.build();

    // Another label of the same length: every post is transformed again
    // and comes out the same.
    await dir.write("tags/t.yml", "label: two\n");
    resetCounts();
    await session.build();
    expect(count("transform")).toBe(3);
    // Every document but the tag.
    expect(count("same")).toBe(3);
    expect(count("where")).toBe(0);

    await dir.write("tags/t.yml", "label: three\n");
    resetCounts();
    await session.build();
    expect(count("same")).toBe(0);
    expect(count("where")).toBe(3);
    expect(await dir.read(".anhur/generated/allPosts.js")).toContain(
      '"tags":[5]',
    );
  });
});

describe("watch targets", () => {
  it("follow the documents a transform keeps, with no file changed", async () => {
    const { dir, session } = await sessionWith({
      "anhur.config.ts": `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { defineField } from "@anhur/core/plugin";
${PROBE}
const cover = defineField(s.string(), {
  kind: "cover",
  whenAbsent: "skip",
  compile: async (input, context) => (await context.resolveLink(String(input), "image")).url,
});
const posts = defineCollection({
  name: "posts",
  directory: "posts",
  include: "*.yml",
  transformCache: false,
  schema: s.object({ title: s.string(), cover }),
  transform: (doc, ctx) => (value("skip") === doc.title ? ctx.skip() : doc),
});
const host = definePlugin({
  name: "test-assets",
  assets: { base: "/files/", dir: ".anhur/assets", extensions: [".png"] },
});
export default defineConfig({ content: [posts], plugins: [host], cacheDir: false, workers: false });
`,
      "posts/a.yml": "title: a\ncover: ./a.png\n",
      "posts/a.png": PNG_1X1,
    });
    const image = dir.path("posts/a.png");
    // Old files: their stat alone proves them unchanged, so the builds
    // below validate nothing again.
    const past = new Date(Date.now() - 60_000);
    await utimes(dir.path("posts/a.yml"), past, past);
    await utimes(image, past, past);

    // The only document with an asset is skipped: nothing to watch for it.
    probe().values.skip = "a";
    const skipped = await session.build();
    expect(skipped.documentCount).toBe(0);
    expect(skipped.watch.files).not.toContain(image);

    probe().values.skip = undefined;
    const kept = await session.build();
    expect(kept.documentCount).toBe(1);
    expect(kept.watch.files).toContain(image);
    expect(await session.watchTargets()).toMatchObject({
      files: expect.arrayContaining([image]),
    });

    probe().values.skip = "a";
    const skippedAgain = await session.build();
    expect(skippedAgain.watch.files).not.toContain(image);
  });
});

describe("stage times", () => {
  const FAILING_VIEW = `
import { defineCollection, defineConfig, defineView, schema as s } from "@anhur/core";
const posts = defineCollection({
  name: "posts",
  directory: "posts",
  include: "*.yml",
  schema: s.object({ title: s.string() }),
});
const broken = defineView({
  name: "broken",
  from: posts,
  where: (doc) => {
    if (doc.title === "bad") throw new Error("no view for this one");
    return true;
  },
});
export default defineConfig({ content: [posts], views: [broken], cacheDir: false, workers: false });
`;

  it("name every stage of a build, and of a dry run", async () => {
    const { dir, session } = await sessionWith({
      "anhur.config.ts": FAILING_VIEW,
      "posts/a.yml": "title: good\n",
    });
    const built = await session.build();
    expect(built.timings.map((timing) => timing.stage)).toEqual([
      "config",
      "discover",
      "validate",
      "transform",
      "relations",
      "views",
      "plugins",
      "plan",
      "publish",
    ]);
    const checked = await check({ rootDir: dir.dir });
    expect(checked.timings.map((timing) => timing.stage)).toEqual([
      "config",
      "discover",
      "validate",
      "transform",
      "relations",
      "views",
      "plugins",
      "plan",
    ]);
  });

  effectIt.live(
    "are kept with the error of a build that failed, up to the stage that failed",
    () =>
      Effect.gen(function* () {
        const dir = yield* Effect.tryPromise(() =>
          createProject({
            "anhur.config.ts": FAILING_VIEW,
            "posts/a.yml": "title: bad\n",
          }),
        );
        projects.push(dir);
        // The failure of the build is the result here: a build that
        // succeeds fails the test.
        const error = yield* Engine.use((engine) =>
          engine.build({ rootDir: dir.dir }),
        ).pipe(Effect.provide(AnhurLive), Effect.flip);
        expect(error.diagnostics).toMatchObject([{ code: "derive-failed" }]);
        expect(failedTimingsOf(error)?.map((timing) => timing.stage)).toEqual([
          "config",
          "discover",
          "validate",
          "transform",
          "relations",
          "views",
        ]);
      }),
  );
});
