import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnhur, type AnhurSession } from "../../src/build";
import { createProject, type TestProject } from "../fixtures/temp-project";

/**
 * A document is the same object in every build of a session, so a write
 * that user code gets through stays in every later build. Every test here
 * tries such writes from the hooks that get documents, and then looks at
 * what the next build of the session sees.
 */

const projects: TestProject[] = [];
const sessions: AnhurSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const project of projects.splice(0)) await project.remove();
});

async function sessionWith(files: { readonly [file: string]: string }) {
  const dir = await createProject(files);
  projects.push(dir);
  const session = createAnhur({ rootDir: dir.dir });
  sessions.push(session);
  return { dir, session };
}

/** What the test configs below record (the config runs in this process). */
// SAFETY: a global the test configs and this file agree on.
const shared = globalThis as { anhurWrites?: string[] };
beforeEach(() => {
  shared.anhurWrites = [];
});
/** The recorded lines, and a clean record for the next build. */
function takeRecord(): string[] {
  const lines = shared.anhurWrites ?? [];
  shared.anhurWrites = [];
  return lines.sort();
}

const RECORDING = `
const record = (line: string) => {
  ((globalThis as { anhurWrites?: string[] }).anhurWrites ??= []).push(line);
};
/** Try a write, and record if it threw. */
const attempt = (name: string, write: () => void) => {
  try {
    write();
    record(name + ": no error");
  } catch (cause) {
    record(name + ": " + (cause instanceof Error ? cause.name : "not an Error"));
  }
};
`;

const READONLY = `
import { defineCollection, defineConfig, defineView, schema as s } from "@anhur/core";
import { definePlugin } from "@anhur/core/plugin";
import { z } from "zod";
${RECORDING}
/** What a hook sees in the first post, then every write a hook could try. */
const writeAll = (place: string, doc: any) => {
  record(place + " saw: " + JSON.stringify([
    doc.rows[0].n,
    doc.box.when.getTime(),
    doc.box.scores.get("a"),
    [...doc.box.tags],
    doc.stamp.getTime(),
  ]));
  attempt(place + " row", () => { doc.rows[0].n = 99; });
  attempt(place + " date", () => { doc.box.when.setTime(0); });
  attempt(place + " map", () => { doc.box.scores.set("a", 99); });
  attempt(place + " set", () => { doc.box.tags.add("new"); });
  attempt(place + " frozen date", () => { doc.stamp.setTime(0); });
};
const posts = defineCollection({
  name: "posts",
  directory: "posts",
  include: "*.yml",
  schema: s.object({
    title: s.string(),
    // Zod freezes the output of .readonly(), one level deep.
    rows: z.array(z.object({ n: z.number() })).readonly(),
    box: z
      .object({
        when: z.coerce.date(),
        scores: z.record(z.string(), z.number()).transform((scores) => new Map(Object.entries(scores))),
        tags: z.array(z.string()).transform((tags) => new Set(tags)),
      })
      .readonly(),
    stamp: z.coerce.date().readonly(),
  }),
  onSuccess: (docs) => {
    writeAll("onSuccess", docs[0]);
  },
});
const notes = defineCollection({
  name: "notes",
  directory: "notes",
  include: "*.yml",
  schema: s.object({ title: s.string() }),
  transform: (doc, ctx) => {
    writeAll("transform", ctx.documents(posts)[0]);
    return doc;
  },
});
const pages = defineCollection({
  name: "pages",
  directory: "pages",
  include: "*.yml",
  // The whole document is read-only for Zod.
  schema: s.object({ title: s.string(), list: z.array(z.object({ n: z.number() })) }).readonly(),
});
const all = defineView({
  name: "all",
  from: posts,
  where: (doc) => {
    if (doc.title === "A") writeAll("where", doc);
    return true;
  },
});
const allPages = defineView({
  name: "allPagesView",
  from: pages,
  where: (doc: any) => {
    if (doc.title !== "P") return true;
    record("page saw: " + JSON.stringify(doc.list));
    attempt("page item", () => { doc.list[0].n = 99; });
    attempt("page list", () => { doc.list.push({ n: 2 }); });
    return true;
  },
});
const writer = definePlugin({
  name: "writer",
  generate: (ctx) => {
    writeAll("generate", ctx.sources.find((source) => source.name === "posts")?.documents[0]);
  },
});
export default defineConfig({
  content: [posts, notes, pages],
  views: [all, allPages],
  plugins: [writer],
  cacheDir: false,
  workers: false,
});
`;

const POST = `title: A
rows:
  - n: 1
box:
  when: 2024-01-01
  scores:
    a: 1
  tags: [x]
stamp: 2024-01-02
`;

const SEEN = JSON.stringify([
  1,
  1_704_067_200_000,
  1,
  ["x"],
  1_704_153_600_000,
]);

/** Every write of every hook threw, and every hook saw the data of the file. */
function allRefused(): string[] {
  const lines = [
    "page item: TypeError",
    "page list: TypeError",
    'page saw: [{"n":1}]',
  ];
  for (const place of ["generate", "onSuccess", "transform", "where"]) {
    lines.push(`${place} saw: ${SEEN}`);
    for (const write of ["date", "frozen date", "map", "row", "set"]) {
      lines.push(`${place} ${write}: TypeError`);
    }
  }
  return lines.sort();
}

describe("documents in a session", () => {
  it("cannot be changed below a .readonly() schema, by any hook", async () => {
    const { dir, session } = await sessionWith({
      "anhur.config.ts": READONLY,
      "posts/a.yml": POST,
      "notes/n.yml": "title: N\n",
      "pages/p.yml": "title: P\nlist:\n  - n: 1\n",
    });
    await session.build();
    expect(takeRecord()).toEqual(allRefused());

    // New documents: every hook runs again, and gets the first post and the
    // page of the first build (the same objects).
    await dir.write("posts/b.yml", POST.replace("title: A", "title: B"));
    await dir.write("pages/q.yml", "title: Q\nlist:\n  - n: 1\n");
    await session.build();
    expect(takeRecord()).toEqual(allRefused());
    expect(await dir.read(".anhur/generated/allPosts.js")).toContain(
      '"rows":[{"n":1}],"box":{"when":new Date(1704067200000),"scores":new Map([["a",1]]),"tags":new Set(["x"])},"stamp":new Date(1704153600000)',
    );
  });

  it("come to every plugin in a list that cannot be changed", async () => {
    const { dir, session } = await sessionWith({
      "anhur.config.ts": `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { definePlugin } from "@anhur/core/plugin";
${RECORDING}
const posts = defineCollection({
  name: "posts",
  directory: "posts",
  include: "*.yml",
  schema: s.object({ title: s.string() }),
});
const sorter = definePlugin({
  name: "sorter",
  generate: (ctx) => {
    const source: any = ctx.sources.find((entry) => entry.name === "posts");
    record("sorter saw: " + source.documents.map((doc: any) => doc.title).join());
    attempt("reverse", () => { source.documents.reverse(); });
    attempt("sort", () => { source.documents.sort((a: any, b: any) => (a.title < b.title ? 1 : -1)); });
    attempt("truncate", () => { source.documents.length = 1; });
    attempt("rename", () => { source.name = "other"; });
    attempt("drop sources", () => { (ctx.sources as any).length = 0; });
  },
});
const reader = definePlugin({
  name: "reader",
  generate: (ctx) => {
    record("reader saw: " + ctx.sources.map((source) => source.name + " " + source.documents.length).join());
  },
});
export default defineConfig({ content: [posts], plugins: [sorter, reader], cacheDir: false, workers: false });
`,
      "posts/a.yml": "title: a\n",
      "posts/b.yml": "title: b\n",
      "posts/c.yml": "title: c\n",
    });
    const refused = [
      "drop sources: TypeError",
      "reader saw: posts 3",
      "rename: TypeError",
      "reverse: TypeError",
      "sort: TypeError",
      "sorter saw: a,b,c",
      "truncate: TypeError",
    ];
    const first = await session.build();
    expect(takeRecord()).toEqual(refused);

    // The summary and the watch targets of a build are kept for the next
    // one: a host cannot change them either.
    const summary = first.sources[0]?.documents ?? [];
    const directories = [...first.watch.directories];
    const files = [...first.watch.files];
    expect(Reflect.set(summary, 0, "damaged")).toBe(false);
    expect(Reflect.set(first.watch.directories, 0, "damaged")).toBe(false);
    expect(Reflect.set(first.watch.files, 0, "damaged")).toBe(false);

    const second = await session.build();
    expect(takeRecord()).toEqual(refused);
    expect(second.sources).toEqual([
      { name: "posts", kind: "collection", documents: ["a", "b", "c"] },
    ]);
    expect(directories).toEqual([dir.path("posts")]);
    expect(second.watch.directories).toEqual(directories);
    expect(second.watch.files).toEqual(files);
  });

  it("says that documents are frozen when a callback writes to one", async () => {
    // Failure: the user only saw the text of the JavaScript engine
    // ("Attempted to assign to readonly property") and no way out.
    const config = (where: string, plugins: string) => `
import { defineCollection, defineConfig, defineView, schema as s } from "@anhur/core";
import { definePlugin } from "@anhur/core/plugin";
const posts = defineCollection({ name: "posts", directory: "posts", include: "*.md", schema: s.object({ title: s.string(), tags: s.array(s.string()) }) });
const titles = defineView({ name: "titles", from: posts, where: (doc) => { ${where} return true; } });
export default defineConfig({ content: [posts], views: [titles], plugins: [${plugins}] });
`;
    const files = { "posts/a.md": "---\ntitle: a\ntags: [x]\n---\n" };
    // `push` throws in every mode; a plain assignment only in strict code.
    const view = await sessionWith({
      ...files,
      "anhur.config.ts": config('doc.tags.push("y");', ""),
    });
    await expect(view.session.build()).rejects.toThrow(
      /Documents and their lists are frozen/,
    );
    const plugin = await sessionWith({
      ...files,
      "anhur.config.ts": config(
        "",
        'definePlugin({ name: "sorter", generate: (ctx) => { ctx.sources[0].documents.push(ctx.sources[0].documents[0]); } })',
      ),
    });
    await expect(plugin.session.build()).rejects.toThrow(
      /Documents and their lists are frozen/,
    );
  });
});
