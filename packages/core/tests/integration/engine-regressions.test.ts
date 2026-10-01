import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  readdir,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  build,
  check,
  createAnhur,
  isAnhurBuildError,
  isRelevantChange,
  watch,
  type AnhurBuildError,
  type BuildResult,
} from "../../src/build";
import {
  createProject,
  PACKAGE_DIR,
  type TestProject,
} from "../fixtures/temp-project";

const run = promisify(execFile);
const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

async function project(files: { readonly [file: string]: string }) {
  const created = await createProject(files);
  projects.push(created);
  return created;
}

function notesConfig(extra = "", schema = "title: s.string()") {
  return `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
const notes = defineCollection({ name: "notes", directory: "notes", include: "**/*.md", schema: s.object({ ${schema} }) });
export default defineConfig({ content: [notes]${extra} });
`;
}

async function failure(promise: Promise<unknown>): Promise<AnhurBuildError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!isAnhurBuildError(error))
    throw new Error(`expected a build error, got ${String(error)}`);
  return error;
}

function isProcessOutput(value: unknown): value is { readonly stdout: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "stdout" in value &&
    typeof value.stdout === "string"
  );
}

function stdoutOf(cause: unknown): string {
  return isProcessOutput(cause) ? cause.stdout : String(cause);
}

function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      if (check()) resolve();
      else if (performance.now() - started > timeoutMs)
        reject(new Error("timed out"));
      else setTimeout(tick, 50);
    };
    tick();
  });
}

describe("watch", () => {
  it("recovers when the first build fails (content folders are watched from the start)", async () => {
    const dir = await project({
      "anhur.config.ts": notesConfig(),
      "notes/a.md": "---\ntitle: [\n---\n",
    });
    const builds: BuildResult[] = [];
    const errors: AnhurBuildError[] = [];
    const controller = await watch(
      { rootDir: dir.dir },
      {
        onBuild: (result) => void builds.push(result),
        onError: (error) => void errors.push(error),
      },
    );
    try {
      await waitFor(() => errors.length === 1);
      await dir.write("notes/a.md", "---\ntitle: Fixed\n---\n");
      await waitFor(() => builds.length === 1);
      expect(builds[0]!.documentCount).toBe(1);
    } finally {
      await controller.close();
    }
  });

  it("matches changes reported through a symlinked path", async () => {
    const dir = await project({
      "anhur.config.ts": notesConfig(),
      "notes/a.md": "---\ntitle: A\n---\n",
    });
    const link = `${dir.dir}-link`;
    await symlink(dir.dir, link);
    try {
      const result = await build({ rootDir: link });
      expect(
        isRelevantChange(path.join(link, "notes/a.md"), result.watch),
      ).toBe(true);
      expect(
        isRelevantChange(
          path.join(link, ".anhur/generated/index.js"),
          result.watch,
        ),
      ).toBe(false);
    } finally {
      await import("node:fs/promises").then((fs) =>
        fs.rm(link, { force: true }),
      );
    }
  });
});

describe("session cache", () => {
  it("keeps a document after a config change that failed it is reverted", async () => {
    const dir = await project({
      "anhur.config.ts": notesConfig(),
      "notes/a.md": "---\ntitle: A\n---\n",
      "notes/b.md": "---\ntitle: B\n---\n",
    });
    const session = createAnhur({ rootDir: dir.dir, mode: "dev" });
    try {
      expect((await session.build()).documentCount).toBe(2);
      await dir.write(
        "anhur.config.ts",
        notesConfig("", "title: s.string().min(2)"),
      );
      await failure(session.build());
      await dir.write("anhur.config.ts", notesConfig());
      const result = await session.build();
      expect(result.sources[0]!.documents).toEqual(["a", "b"]);
    } finally {
      await session.close();
    }
  });

  it("validates a file separately for every source that includes it", async () => {
    const dir = await project({
      "anhur.config.ts": `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
const posts = defineCollection({ name: "posts", directory: "content", include: "*.md", schema: s.object({ title: s.string() }) });
const pages = defineCollection({ name: "pages", directory: "content", include: "*.md", schema: s.object({ title: s.string(), extra: s.string().default("x") }) });
export default defineConfig({ content: [posts, pages] });
`,
      "content/a.md": "---\ntitle: A\n---\n",
    });
    const result = await build({ rootDir: dir.dir });
    expect(result.sources.map((source) => source.documents)).toEqual([
      ["a"],
      ["a"],
    ]);
    expect(await dir.read(".anhur/generated/allPages.js")).toContain(
      '"extra":"x"',
    );
  });

  it("serializes concurrent builds of one session, so the newest content wins", async () => {
    const dir = await project({
      "anhur.config.ts": notesConfig(),
      "notes/a.md": "---\ntitle: v1\n---\n",
    });
    const session = createAnhur({ rootDir: dir.dir });
    try {
      const first = session.build();
      await dir.write("notes/a.md", "---\ntitle: v2\n---\n");
      const second = session.build();
      await Promise.all([first, second]);
      expect(await dir.read(".anhur/generated/allNotes.js")).toContain('"v2"');
    } finally {
      await session.close();
    }
  });
});

describe("cache folder", () => {
  it("never deletes files it did not write", async () => {
    const dir = await project({
      "anhur.config.ts": notesConfig(', cacheDir: "src"'),
      "notes/a.md": "---\ntitle: A\n---\n",
      "src/fields/TextField.tsx": "export {};\n",
    });
    await build({ rootDir: dir.dir });
    expect(await readdir(dir.path("src/fields"))).toContain("TextField.tsx");
  });

  it("check never writes the field cache and refuses folders build would refuse", async () => {
    const dir = await project({
      "anhur.config.ts": notesConfig(
        "",
        "title: s.string(), excerpt: s.excerpt()",
      ),
      "notes/a.md": "---\ntitle: A\n---\nBody text.\n",
    });
    await check({ rootDir: dir.dir });
    const cache = await readdir(dir.path(".anhur/cache/fields")).catch(
      () => [],
    );
    expect(cache).toEqual([]);

    const owned = await project({
      "anhur.config.ts": notesConfig(', outputDir: "out"'),
      "notes/a.md": "---\ntitle: A\n---\n",
      "out/keep.txt": "mine",
    });
    const error = await failure(check({ rootDir: owned.dir }));
    expect(error.diagnostics[0]?.code).toBe("output-unsafe");
  });
});

describe("output", () => {
  it("handles a case-only rename of a generated module", async () => {
    const config = (typeName: string) => `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
export default defineConfig({ content: [defineCollection({ name: "posts", typeName: "${typeName}", directory: "notes", include: "*.md", schema: s.object({ title: s.string() }) })] });
`;
    const dir = await project({
      "anhur.config.ts": config("BlogPost"),
      "notes/a.md": "---\ntitle: A\n---\n",
    });
    await build({ rootDir: dir.dir });
    await dir.write("anhur.config.ts", config("Blogpost"));
    await build({ rootDir: dir.dir });
    const files = await readdir(dir.path(".anhur/generated"));
    expect(files).toContain("getBlogpost.js");
    expect(files).not.toContain("getBlogPost.js");
    const generated: {
      getBlogpost: (id: string) => Promise<{ title: string } | null>;
    } = await import(
      `${dir.path(".anhur/generated/index.js")}?v=${Date.now()}`
    );
    expect((await generated.getBlogpost("a"))?.title).toBe("A");
  });

  it("rewrites a generated file that was edited by hand", async () => {
    const dir = await project({
      "anhur.config.ts": notesConfig(),
      "notes/a.md": "---\ntitle: A\n---\n",
    });
    await build({ rootDir: dir.dir });
    await writeFile(dir.path(".anhur/generated/allNotes.js"), "broken");
    const result = await build({ rootDir: dir.dir });
    expect(result.written.map((file) => path.basename(file))).toContain(
      "allNotes.js",
    );
  });

  it("takes over a lock file that stayed empty and old", async () => {
    const dir = await project({
      "anhur.config.ts": notesConfig(),
      "notes/a.md": "---\ntitle: A\n---\n",
    });
    const lock = dir.path(".anhur/generated.lock");
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, "");
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    const result = await build({ rootDir: dir.dir });
    expect(result.documentCount).toBe(1);
  });

  it("generated declarations survive names that shadow globals and imports", async () => {
    const dir = await project({
      "anhur.config.ts": `
import { defineCollection, defineConfig, defineSingleton, schema as s } from "@anhur/core";
const promises = defineCollection({ name: "promises", directory: "promises", include: "*.md", schema: s.object({ title: s.string() }) });
const configuration = defineSingleton({ name: "configuration", filePath: "configuration.yml", schema: s.object({ site: s.string() }) });
const arrays = defineCollection({ name: "arrays", directory: "arrays", include: "*.md", schema: s.object({ title: s.string() }) });
export default defineConfig({ content: [promises, configuration, arrays] });
`,
      "promises/a.md": "---\ntitle: A\n---\n",
      "arrays/a.md": "---\ntitle: A\n---\n",
      "configuration.yml": "site: S\n",
    });
    await build({ rootDir: dir.dir });
    // Type-check the declarations as source (skipLibCheck would hide errors in a .d.ts).
    await copyFile(
      dir.path(".anhur/generated/index.d.ts"),
      dir.path(".anhur/generated/declarations.ts"),
    );
    await writeFile(
      dir.path("consumer.ts"),
      `import { getPromise, allPromises, configuration } from "./.anhur/generated/declarations";
const one: Promise<{ title: string } | null> = getPromise("a");
const titles: string[] = allPromises.map((item) => item.title);
const site: string = configuration.site;
export { one, titles, site };
`,
    );
    const result = await run(
      "bunx",
      [
        "tsc",
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--target",
        "es2024",
        "--skipLibCheck",
        "--types",
        "node",
        "consumer.ts",
      ],
      { cwd: dir.dir },
    ).then(
      () => "",
      (cause: unknown) => stdoutOf(cause),
    );
    expect(result).toBe("");
  }, 60_000);
});

describe("documents", () => {
  it("reports non-plain values from schemas with the field path", async () => {
    const dir = await project({
      "anhur.config.ts": notesConfig(
        "",
        "title: s.string(), link: s.string().transform((value) => new URL(value))",
      ),
      "notes/a.md": "---\ntitle: A\nlink: https://example.com/\n---\n",
    });
    const error = await failure(build({ rootDir: dir.dir }));
    expect(error.diagnostics[0]).toMatchObject({
      code: "validation-failed",
      fieldPath: ["link"],
    });
    expect(error.diagnostics[0]?.message).toContain("URL instance");
  });

  it("reports class instances returned by a transform", async () => {
    const dir = await project({
      "anhur.config.ts": `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
class Money { constructor(readonly cents: number) {} }
const notes = defineCollection({ name: "notes", directory: "notes", include: "*.md", schema: s.object({ title: s.string() }),
  transform: (doc) => ({ ...doc, price: new Money(20) as never }) });
export default defineConfig({ content: [notes] });
`,
      "notes/a.md": "---\ntitle: A\n---\n",
    });
    const error = await failure(build({ rootDir: dir.dir }));
    expect(error.diagnostics[0]).toMatchObject({
      code: "transform-failed",
      fieldPath: ["price"],
    });
  });

  it("drops documents with draft: true even when the schema does not declare draft", async () => {
    const dir = await project({
      "anhur.config.ts": notesConfig(),
      "notes/a.md": "---\ntitle: A\n---\n",
      "notes/b.md": "---\ntitle: B\ndraft: true\n---\n",
    });
    const result = await build({ rootDir: dir.dir });
    expect(result.sources[0]!.documents).toEqual(["a"]);
  });

  it("uses composed (NFC) ids for decomposed file names", async () => {
    const decomposed = "café";
    const dir = await project({
      "anhur.config.ts": notesConfig(),
      [`notes/${decomposed}.md`]: "---\ntitle: C\n---\n",
    });
    const result = await build({ rootDir: dir.dir });
    expect(result.sources[0]!.documents).toEqual(["café"]);
  });

  it("rejects names that are unsafe in generated code", async () => {
    const dir = await project({
      "anhur.config.ts": `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
export default defineConfig({ content: [defineCollection({ name: "posts */ throw 1; /*", directory: "notes", include: "*.md", schema: s.object({ title: s.string() }) })] });
`,
      "notes/a.md": "---\ntitle: A\n---\n",
    });
    const error = await failure(build({ rootDir: dir.dir }));
    expect(error.diagnostics[0]?.code).toBe("naming-invalid");
  });

  it("checks references after prepare removed a target", async () => {
    const dir = await project({
      "anhur.config.ts": `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
const authors = defineCollection({ name: "authors", directory: "authors", include: "*.yml", schema: s.object({ name: s.string() }) });
const posts = defineCollection({ name: "posts", directory: "posts", include: "*.md", schema: s.object({ author: s.reference("authors") }) });
export default defineConfig({
  content: [authors, posts],
  prepare: (sources) => {
    const group = sources.find((source) => source.name === "authors");
    if (group) group.documents = [];
  },
});
`,
      "authors/ada.yml": "name: Ada\n",
      "posts/a.md": "---\nauthor: ada\n---\n",
    });
    const error = await failure(build({ rootDir: dir.dir }));
    expect(error.diagnostics[0]?.code).toBe("reference-failed");
  });

  it("keys index rows correctly when select() returns a shared object", async () => {
    const dir = await project({
      "anhur.config.ts": `
import { defineCollection, defineConfig, defineIndex, schema as s } from "@anhur/core";
const notes = defineCollection({ name: "notes", directory: "notes", include: "*.md", schema: s.object({ title: s.string() }) });
const shared = { kind: "note" };
const byTitle = defineIndex({ name: "noteByTitle", from: notes, key: "title", select: () => shared });
export default defineConfig({ content: [notes], views: [byTitle] });
`,
      "notes/a.md": "---\ntitle: A\n---\n",
      "notes/b.md": "---\ntitle: B\n---\n",
    });
    await build({ rootDir: dir.dir });
    const index = await dir.read(".anhur/generated/noteByTitle.js");
    expect(index).toContain('"A"');
    expect(index).toContain('"B"');
  });

  it("warns when a string lookup is ambiguous between id and slug", async () => {
    const dir = await project({
      "anhur.config.ts": notesConfig("", "title: s.string(), slug: s.slug()"),
      "notes/intro.md": "---\ntitle: A\nslug: first\n---\n",
      "notes/first.md": "---\ntitle: B\nslug: second\n---\n",
    });
    const result = await build({ rootDir: dir.dir });
    expect(
      result.warnings.map((warning) => warning.message).join("\n"),
    ).toContain('"first" is the');
  });
});

describe("config", () => {
  it("tracks config imports outside the project folder", async () => {
    const dir = await project({
      "app/anhur.config.ts": `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { PREFIX } from "../shared/consts";
const notes = defineCollection({ name: "notes", directory: "notes", include: "*.md", schema: s.object({ title: s.string() }), transform: (doc) => ({ ...doc, title: PREFIX + doc.title }) });
export default defineConfig({ content: [notes] });
`,
      "shared/consts.ts": 'export const PREFIX = "v1:";\n',
      "app/notes/a.md": "---\ntitle: a\n---\n",
    });
    const session = createAnhur({ rootDir: dir.path("app") });
    try {
      const first = await session.build();
      expect(first.watch.files).toContain(dir.path("shared/consts.ts"));
      await dir.write("shared/consts.ts", 'export const PREFIX = "v2:";\n');
      await session.build();
      expect(await dir.read("app/.anhur/generated/allNotes.js")).toContain(
        '"v2:a"',
      );
    } finally {
      await session.close();
    }
  });
});

describe("cli", () => {
  it("prints the JSON report to stdout on failure", async () => {
    const dir = await project({
      "anhur.config.ts": notesConfig(),
      "notes/a.md": "---\n---\n",
    });
    const cli = path.join(PACKAGE_DIR, "src/cli/main.ts");
    const failed: unknown = await run("bun", [
      cli,
      "check",
      "--root",
      dir.dir,
      "--json",
    ]).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    const stdout = stdoutOf(failed);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "validation-failed" }],
    });
  });
});
