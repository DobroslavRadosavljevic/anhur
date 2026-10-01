import { afterEach, describe, expect, it } from "vitest";
import { build, isAnhurBuildError, type Diagnostic } from "../../src/build";
import { createProject, type TestProject } from "../fixtures/temp-project";

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

async function diagnosticsOf(files: {
  readonly [file: string]: string;
}): Promise<readonly Diagnostic[]> {
  const project = await createProject(files);
  projects.push(project);
  const error = await build({ rootDir: project.dir }).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!isAnhurBuildError(error))
    throw new Error(`expected a build error, got ${String(error)}`);
  return error.diagnostics;
}

const header = `import { defineCollection, defineConfig, schema as s } from "@anhur/core";\n`;

describe("diagnostics", () => {
  it("reports every invalid file with its field path", async () => {
    const diagnostics = await diagnosticsOf({
      "anhur.config.ts": `${header}
export default defineConfig({ content: [defineCollection({ name: "posts", directory: "posts", include: "*.md", schema: s.object({ title: s.string(), date: s.isodate() }) })] });`,
      "posts/a.md": "---\ndate: 2024-02-30\n---\n",
      "posts/b.md": "---\ntitle: 1\ndate: 2024-01-01\n---\n",
      "posts/c.md": "---js\n{}\n---\n",
    });
    const lines = diagnostics.map(
      (d) =>
        `${d.code} ${d.file?.split("/").pop()} ${(d.fieldPath ?? []).join(".")}`,
    );
    expect(lines).toEqual(
      expect.arrayContaining([
        "validation-failed a.md title",
        "validation-failed a.md date",
        "validation-failed b.md title",
        "loader-failed c.md ",
      ]),
    );
  });

  it("reports duplicate ids, including case-only differences", async () => {
    const diagnostics = await diagnosticsOf({
      "anhur.config.ts": `${header}
export default defineConfig({ content: [defineCollection({ name: "posts", directory: "posts", include: "*.{md,mdx}", schema: s.object({}) })] });`,
      "posts/dup.md": "x",
      "posts/dup.mdx": "y",
    });
    expect(diagnostics.map((d) => d.code)).toEqual(["duplicate-id"]);
  });

  it("checks references after transforms and reports all unique conflicts per field", async () => {
    const diagnostics = await diagnosticsOf({
      "anhur.config.ts": `${header}
const authors = defineCollection({ name: "authors", directory: "authors", include: "*.yml",
  schema: s.object({ name: s.string(), hidden: s.boolean().optional() }),
  transform: (doc, ctx) => (doc.hidden ? ctx.skip() : doc) });
const items = defineCollection({ name: "items", directory: "items", include: "*.yml",
  schema: s.object({ author: s.reference("authors"), sku: s.unique(), code: s.unique() }) });
export default defineConfig({ content: [authors, items] });`,
      "authors/ada.yml": "name: Ada\n",
      "authors/ghost.yml": "name: Ghost\nhidden: true\n",
      "items/a.yml": "author: ada\nsku: x1\ncode: c1\n",
      "items/b.yml": "author: ghost\nsku: y1\ncode: x1\n",
      "items/c.yml": "author: nobody\nsku: x1\ncode: c3\n",
    });
    const lines = diagnostics.map(
      (d) =>
        `${d.code} ${d.file?.split("/").pop()} ${(d.fieldPath ?? []).join(".")}`,
    );
    expect(lines).toContain("reference-failed b.yml author");
    expect(lines).toContain("reference-failed c.yml author");
    expect(lines).toContain("unique-conflict c.yml sku");
    expect(lines.filter((line) => line.includes("code"))).toEqual([]);
  });

  it("validates transform results and keeps _meta", async () => {
    const diagnostics = await diagnosticsOf({
      "anhur.config.ts": `${header}
export default defineConfig({ content: [defineCollection({ name: "posts", directory: "posts", include: "*.md", schema: s.object({}),
  transform: (doc) => (doc._meta.id === "a" ? undefined : [1]) as never })] });`,
      "posts/a.md": "x",
      "posts/b.md": "y",
    });
    expect(diagnostics.map((d) => d.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("got undefined"),
        expect.stringContaining("got an array"),
      ]),
    );
  });

  it("turns view callback errors and prototype keys into diagnostics", async () => {
    const diagnostics = await diagnosticsOf({
      "anhur.config.ts": `import { defineCollection, defineConfig, defineIndex, schema as s } from "@anhur/core";
const tags = defineCollection({ name: "tags", directory: "tags", include: "*.yml", schema: s.object({ key: s.string() }) });
const byKey = defineIndex({ name: "byKey", from: tags, key: "key" });
const broken = defineIndex({ name: "broken", from: tags, key: () => { throw new Error("boom"); } });
export default defineConfig({ content: [tags], views: [byKey, broken] });`,
      "tags/a.yml": "key: toString\n",
      "tags/b.yml": "key: constructor\n",
    });
    expect(diagnostics.map((d) => d.code)).toEqual([
      "derive-failed",
      "derive-failed",
    ]);
    expect(diagnostics.every((d) => d.message.includes("boom"))).toBe(true);
  });

  it("reports values that are not plain data with their field path", async () => {
    const diagnostics = await diagnosticsOf({
      "anhur.config.ts": `${header}
export default defineConfig({ content: [defineCollection({ name: "posts", directory: "posts", include: "*.md", schema: s.object({}),
  transform: (doc) => ({ ...doc, when: new URL("https://x.y") }) as never })] });`,
      "posts/a.md": "x",
    });
    expect(diagnostics[0]).toMatchObject({
      code: "transform-failed",
      fieldPath: ["when"],
    });
  });

  it("reports a missing collection folder instead of building nothing", async () => {
    const diagnostics = await diagnosticsOf({
      "anhur.config.ts": `${header}
export default defineConfig({ content: [defineCollection({ name: "posts", directory: "postz", include: "*.md", schema: s.object({}) })] });`,
    });
    expect(diagnostics.map((d) => d.code)).toEqual(["source-missing"]);
  });
});
