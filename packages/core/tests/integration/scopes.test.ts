/**
 * Scopes: extra outputs with only some documents.
 *
 * Ways it can fail, each checked below:
 * - a scope output keeps a document its `where` drops, or loses one it keeps;
 * - a source with no `where` loses documents in the scope;
 * - the main output loses documents because a scope dropped them;
 * - views, getters and indexes of a scope still list dropped documents;
 * - a kept document that points to a dropped one builds anyway (a broken
 *   reference in the scope output);
 * - a failing scope still writes the main output (half a build), also
 *   when its folder holds files Anhur did not write;
 * - `check` passes where `build` fails;
 * - a callback that throws or returns no boolean is ignored;
 * - `ctx.documents()` in `where` gives other sources' documents wrongly;
 * - a rebuild in a session does not update the scope output;
 * - `onSuccess` and `complete` run once per output instead of once;
 * - bad scope config (names, folders, sources) is accepted.
 */
import { access, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  build,
  check,
  createAnhur,
  isAnhurBuildError,
  type BuildResult,
} from "../../src/build";
import { createProject, type TestProject } from "../fixtures/temp-project";

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

async function project(files: { readonly [file: string]: string }) {
  const created = await createProject(files);
  projects.push(created);
  return created;
}

function config(scopes: string, extra = ""): string {
  return `
import { defineCollection, defineConfig, defineView, schema as s } from "@anhur/core";

const items = defineCollection({
  name: "items",
  directory: "content/items",
  include: "*.md",
  localized: false,
  schema: s.object({
    title: s.string(),
    status: s.enum(["draft", "published"]),
    partOf: s.reference("items").optional(),
    related: s.array(s.reference("items")).optional(),
    body: s.raw(),
  }),
});

const families = defineCollection({
  name: "families",
  directory: "content/families",
  include: "*.yml",
  localized: false,
  schema: s.object({ title: s.string() }),
});

const published = defineView({
  name: "publishedItems",
  from: items,
  where: (doc) => doc.status === "published",
});

${extra}

export default defineConfig({
  content: [items, families],
  views: [published],
  scopes: ${scopes},
});
`;
}

const PUBLIC_SCOPE = `[
  {
    name: "public",
    outputDir: ".anhur/public",
    where: {
      items: (doc, ctx) => {
        if (!doc.partOf) return doc.status === "published";
        const parent = ctx.documents(items).find((item) => item._meta.id === doc.partOf);
        return ctx.scope === "public" && parent?.status === "published";
      },
    },
  },
]`;

const FILES = {
  "content/items/button.md":
    "---\ntitle: Button\nstatus: published\n---\nUse it.\n",
  "content/items/button-icon.md":
    "---\ntitle: Button icon\nstatus: draft\npartOf: button\n---\n",
  "content/items/wheel.md": "---\ntitle: Wheel\nstatus: draft\n---\nSoon.\n",
  "content/items/wheel-drum.md":
    "---\ntitle: Wheel drum\nstatus: draft\npartOf: wheel\n---\n",
  "content/families/forms.yml": "title: Forms\n",
};

type Generated = {
  readonly allItems: readonly { readonly title: string }[];
  readonly allFamilies: readonly { readonly title: string }[];
  readonly allPublishedItems: readonly { readonly title: string }[];
  readonly getItem: (id: string) => Promise<{ readonly title: string } | null>;
};

async function importIndex(dir: string): Promise<Generated> {
  // SAFETY: the generated index exports the members listed in Generated (checked by the assertions below).
  return (await import(
    `${pathToFileURL(`${dir}/index.js`).href}?t=${Math.random()}`
  )) as Generated;
}

const titles = (list: readonly { readonly title: string }[]) =>
  list.map((entry) => entry.title).sort();

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function failure(run: Promise<unknown>) {
  const error = await run.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!isAnhurBuildError(error)) {
    throw new Error(`expected an AnhurBuildError, got ${String(error)}`);
  }
  return error;
}

describe("scopes", () => {
  it("writes a scope output with only the kept documents, and keeps all of them in the main output", async () => {
    const site = await project({
      "anhur.config.ts": config(PUBLIC_SCOPE),
      ...FILES,
    });
    const result = await build({ rootDir: site.dir });

    expect(result.documentCount).toBe(5);
    expect(result.scopes).toHaveLength(1);
    const scope = result.scopes[0]!;
    expect(scope.name).toBe("public");
    expect(scope.outputDir).toBe(site.path(".anhur/public"));
    expect(scope.documentCount).toBe(3);
    expect(
      [
        ...(scope.sources.find((source) => source.name === "items")
          ?.documents ?? []),
      ].sort(),
    ).toEqual(["button", "button-icon"]);
    expect(scope.written.length).toBeGreaterThan(0);
    expect(
      scope.written.every((file) => file.startsWith(scope.outputDir)),
    ).toBe(true);
    // `written` of the build counts every output.
    for (const file of scope.written) expect(result.written).toContain(file);

    const main = await importIndex(site.path(".anhur/generated"));
    expect(titles(main.allItems)).toEqual([
      "Button",
      "Button icon",
      "Wheel",
      "Wheel drum",
    ]);

    const scoped = await importIndex(site.path(".anhur/public"));
    expect(titles(scoped.allItems)).toEqual(["Button", "Button icon"]);
    expect(titles(scoped.allFamilies)).toEqual(["Forms"]);
    expect(titles(scoped.allPublishedItems)).toEqual(["Button"]);
    expect((await scoped.getItem("button"))?.title).toBe("Button");
    expect(await scoped.getItem("wheel")).toBeNull();
    // One module per kept document: `<id>-<hash>.js`.
    const modules = await readdir(site.path(".anhur/public/documents/items"));
    expect(
      modules.map((name) => name.replace(/-[0-9a-f]+\.js$/, "")).sort(),
    ).toEqual(["button", "button-icon"]);
  });

  it("fails the whole build when a kept document points to a dropped one, and writes nothing", async () => {
    const site = await project({
      "anhur.config.ts": config(PUBLIC_SCOPE),
      ...FILES,
      "content/items/button.md":
        "---\ntitle: Button\nstatus: published\nrelated: [wheel]\n---\n",
    });
    const error = await failure(build({ rootDir: site.dir }));
    const problem = error.diagnostics.find(
      (diagnostic) => diagnostic.code === "reference-failed",
    );
    expect(problem?.message).toMatch(/^Scope "public": /);
    expect(problem?.message).toContain('"wheel"');
    expect(problem?.hint).toContain("this scope leaves out");
    expect(await exists(site.path(".anhur/generated"))).toBe(false);
    expect(await exists(site.path(".anhur/public"))).toBe(false);

    const checked = await failure(check({ rootDir: site.dir }));
    expect(
      checked.diagnostics.some(
        (diagnostic) => diagnostic.code === "reference-failed",
      ),
    ).toBe(true);
  });

  it("writes nothing when a scope folder holds files Anhur did not write", async () => {
    const site = await project({
      "anhur.config.ts": config(PUBLIC_SCOPE),
      ...FILES,
      ".anhur/public/keep.txt": "mine",
    });
    const error = await failure(build({ rootDir: site.dir }));
    expect(error.diagnostics[0]?.code).toBe("output-unsafe");
    expect(await exists(site.path(".anhur/generated"))).toBe(false);
    await failure(check({ rootDir: site.dir }));
  });

  it("reports a where callback that throws or returns no boolean, with the file", async () => {
    const throwing = await project({
      "anhur.config.ts": config(`[
        { name: "public", outputDir: ".anhur/public", where: { items: (doc) => { if (doc.title === "Wheel") throw new Error("no wheels"); return true; } } },
      ]`),
      ...FILES,
    });
    const thrown = await failure(build({ rootDir: throwing.dir }));
    expect(thrown.diagnostics).toEqual([
      expect.objectContaining({
        code: "scope-failed",
        source: "items",
        file: throwing.path("content/items/wheel.md"),
        message: 'Scope "public": where.items threw: no wheels',
      }),
    ]);

    const loose = await project({
      "anhur.config.ts": config(`[
        // SAFETY: a JS-style callback that returns a string; the build must refuse it.
        { name: "public", outputDir: ".anhur/public", where: { items: ((doc: { title: string }) => doc.title) as unknown as () => boolean } },
      ]`),
      ...FILES,
    });
    const notBoolean = await failure(build({ rootDir: loose.dir }));
    expect(notBoolean.diagnostics[0]?.message).toBe(
      'Scope "public": where.items must return true or false, got a string.',
    );
    expect(notBoolean.diagnostics).toHaveLength(4);
  });

  it("updates the scope output in a session when a document changes status", async () => {
    const site = await project({
      "anhur.config.ts": config(PUBLIC_SCOPE),
      ...FILES,
    });
    const session = createAnhur({ rootDir: site.dir });
    try {
      const first = await session.build();
      expect(first.scopes[0]?.documentCount).toBe(3);

      const same = await session.build();
      expect(same.written).toEqual([]);
      expect(same.scopes[0]?.written).toEqual([]);

      await site.write(
        "content/items/wheel.md",
        "---\ntitle: Wheel\nstatus: published\n---\nNow.\n",
      );
      const published = await session.build();
      const scope = published.scopes[0]!;
      expect(scope.documentCount).toBe(5);
      expect(
        scope.written.some((file) =>
          /documents\/items\/wheel-[0-9a-f]+\.js$/.test(file),
        ),
      ).toBe(true);
      expect(
        scope.written.some((file) =>
          /documents\/items\/wheel-drum-[0-9a-f]+\.js$/.test(file),
        ),
      ).toBe(true);

      await site.write(
        "content/items/wheel.md",
        "---\ntitle: Wheel\nstatus: draft\n---\nLater.\n",
      );
      const hidden = await session.build();
      expect(hidden.scopes[0]?.documentCount).toBe(3);
      expect(
        hidden.scopes[0]?.removed.some((file) =>
          /documents\/items\/wheel-[0-9a-f]+\.js$/.test(file),
        ),
      ).toBe(true);
      const scoped = await importIndex(site.path(".anhur/public"));
      expect(titles(scoped.allItems)).toEqual(["Button", "Button icon"]);
    } finally {
      await session.close();
    }
  });

  it("runs onSuccess and complete once per build, for the main output", async () => {
    const site = await project({
      "anhur.config.ts": config(PUBLIC_SCOPE).replace(
        "export default defineConfig({",
        `globalThis.__anhurScopeHooks = [];
export default defineConfig({
  complete: (sources, ctx) => { globalThis.__anhurScopeHooks.push(ctx.outputDir); },`,
      ),
      ...FILES,
    });
    const result: BuildResult = await build({ rootDir: site.dir });
    // SAFETY: the config above sets this global when it loads; `complete` fills it.
    const collected =
      (globalThis as { __anhurScopeHooks?: string[] }).__anhurScopeHooks ?? [];
    expect(collected).toEqual([result.outputDir]);
  });

  it("does not change a build without scopes", async () => {
    const site = await project({
      "anhur.config.ts": config("undefined"),
      ...FILES,
    });
    const result = await build({ rootDir: site.dir });
    expect(result.scopes).toEqual([]);
    expect(result.timings.some((timing) => timing.stage === "scopes")).toBe(
      false,
    );
  });

  it.each([
    [
      "a duplicate name",
      `[{ name: "public", outputDir: ".anhur/a" }, { name: "public", outputDir: ".anhur/b" }]`,
      '"public" is used by more than one scope.',
    ],
    [
      "a bad name",
      `[{ name: "1st", outputDir: ".anhur/a" }]`,
      'Scope name "1st" must start with a letter',
    ],
    [
      "no outputDir",
      `[{ name: "public", outputDir: "" }]`,
      'Scope "public" needs an outputDir',
    ],
    [
      "the main output folder",
      `[{ name: "public", outputDir: ".anhur/generated" }]`,
      'The outputDir of scope "public" and outputDir must be separate folders.',
    ],
    [
      "a folder inside another scope",
      `[{ name: "a", outputDir: ".anhur/a" }, { name: "b", outputDir: ".anhur/a/b" }]`,
      'The outputDir of scope "b" and the outputDir of scope "a" must be separate folders.',
    ],
    [
      "the content folder",
      `[{ name: "public", outputDir: "content" }]`,
      'outputDir of scope "public" "',
    ],
    [
      "a folder inside the content",
      `[{ name: "public", outputDir: "content/items/public" }]`,
      'The outputDir of scope "public" is inside the content of "items", which would read its files back as content.',
    ],
    [
      "an unknown source",
      // SAFETY: an unknown key, as a plain JS config could have; the build must refuse it.
      `[{ name: "public", outputDir: ".anhur/a", where: { posts: () => true } as never }]`,
      'Scope "public": where names "posts", which is not a collection or singleton.',
    ],
    [
      "a filter that is not a function",
      // SAFETY: a wrong value, as a plain JS config could have; the build must refuse it.
      `[{ name: "public", outputDir: ".anhur/a", where: { items: true } as never }]`,
      'Scope "public": where.items must be a function.',
    ],
  ])("refuses %s", async (_label, scopes, message) => {
    const site = await project({
      "anhur.config.ts": config(scopes),
      ...FILES,
    });
    const error = await failure(build({ rootDir: site.dir }));
    expect(
      error.diagnostics.some((diagnostic) =>
        diagnostic.message.includes(message),
      ),
    ).toBe(true);
  });
});
