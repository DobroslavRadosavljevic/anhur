import { readdir, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { build, isAnhurBuildError } from "@anhur/core/build";
import {
  createProject,
  PNG_1X1,
  type TestProject,
} from "../fixtures/temp-project";

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

const config = (options: string) => `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { assets, schema as a } from "@anhur/assets";

const products = defineCollection({
  name: "products",
  directory: "content",
  include: "*.yml",
  schema: s.object({
    cover: a.image(),
    hero: a.image({ allowRemote: true }).optional(),
    brochure: a.file().optional(),
  }),
});
export default defineConfig({ content: [products], plugins: [assets(${options})] });
`;

describe("assets plugin", () => {
  it("copies images and files with sizes, content types and blur", async () => {
    const project = await createProject({
      "anhur.config.ts": config("{}"),
      "content/img/a.png": PNG_1X1,
      "content/doc.pdf": "%PDF-1.4",
      "content/kit.yml":
        "cover: ./img/a.png\nhero: https://cdn.example.com/x.png\nbrochure: ./doc.pdf\n",
    });
    projects.push(project);
    const result = await build({ rootDir: project.dir });
    expect(result.assets).toMatchObject({
      publicBase: "/anhur-assets/",
      localBase: "/anhur-assets/",
      count: 2,
    });
    const list = await project.read(".anhur/generated/allProducts.js");
    expect(list).toMatch(
      /"cover":\{"src":"\/anhur-assets\/a-[0-9a-f]{16}\.png","width":1,"height":1,"contentType":"image\/png","blurDataURL":"data:image\/webp;base64,/,
    );
    expect(list).toContain(
      '"hero":{"src":"https://cdn.example.com/x.png","remote":true}',
    );
    expect(list).toMatch(
      /"brochure":\{"src":"\/anhur-assets\/doc-[0-9a-f]{16}\.pdf","size":8,"contentType":"application\/pdf"\}/,
    );
    expect((await readdir(project.path(".anhur/assets"))).length).toBe(3);
  });

  it("rejects remote URLs unless allowed, and unsafe folders at config time", async () => {
    const remote = await createProject({
      "anhur.config.ts": config("{}"),
      "content/kit.yml": "cover: https://cdn.example.com/x.png\n",
    });
    projects.push(remote);
    const error = await build({ rootDir: remote.dir }).catch(
      (cause: unknown) => cause,
    );
    expect(isAnhurBuildError(error) && error.message).toContain(
      "needs a path relative to the document",
    );

    const unsafe = await createProject({
      "anhur.config.ts": config('{ dir: "." }'),
      "content/kit.yml": "cover: ./a.png\n",
    });
    projects.push(unsafe);
    const unsafeError = await build({ rootDir: unsafe.dir }).catch(
      (cause: unknown) => cause,
    );
    expect(isAnhurBuildError(unsafeError) && unsafeError.message).toContain(
      "project folder",
    );

    const mismatch = await createProject({
      "anhur.config.ts": config(
        '{ base: "https://cdn.example.com/other/", storage: { prefix: "site", files: {} as never } }',
      ),
      "content/kit.yml": "cover: ./a.png\n",
    });
    projects.push(mismatch);
    const mismatchError = await build({ rootDir: mismatch.dir }).catch(
      (cause: unknown) => cause,
    );
    expect(isAnhurBuildError(mismatchError) && mismatchError.message).toContain(
      "does not end with the storage prefix",
    );
  });

  it("uses a local base in dev when the CDN is only filled by builds", async () => {
    const project = await createProject({
      "anhur.config.ts": config(
        '{ base: "https://cdn.example.com/site/", storage: { prefix: "site", files: {} as never } }',
      ),
      "content/img/a.png": PNG_1X1,
      "content/kit.yml": "cover: ./img/a.png\n",
    });
    projects.push(project);
    const result = await build({ rootDir: project.dir, mode: "dev" });
    expect(result.assets?.publicBase).toBe("/anhur-assets/");
  });

  it("names sanitized SVGs apart from kept ones, so switching modes re-copies them", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><script>alert(1)</script><rect width="4" height="2"/></svg>';
    const keep = await createProject({
      "anhur.config.ts": config('{ svg: "keep" }'),
      "content/logo.svg": svg,
      "content/kit.yml": "cover: ./logo.svg\n",
    });
    projects.push(keep);
    await build({ rootDir: keep.dir });
    const kept = await readdir(keep.path(".anhur/assets"));
    const keptName = kept.find((file) => file.endsWith(".svg"));
    expect(
      await readFile(keep.path(`.anhur/assets/${keptName}`), "utf8"),
    ).toContain("<script>");

    await keep.write("anhur.config.ts", config("{}"));
    await build({ rootDir: keep.dir });
    const files = await readdir(keep.path(".anhur/assets"));
    const sanitized = files.find((file) => file.endsWith(".svg"));
    expect(sanitized).toMatch(/^logo-[0-9a-f]{16}\.svg$/);
    expect(sanitized).not.toBe(keptName);
    expect(files).not.toContain(keptName);
    expect(
      await readFile(keep.path(`.anhur/assets/${sanitized}`), "utf8"),
    ).not.toContain("script");
    expect(await keep.read(".anhur/generated/allProducts.js")).toContain(
      `"src":"/anhur-assets/${sanitized}","width":4,"height":2`,
    );
  });

  it("copies only media by default and never from node_modules", async () => {
    const project = await createProject({
      "anhur.config.ts": config("{}"),
      "service-account.json": '{"private_key":"x"}',
      "node_modules/pkg/doc.pdf": "%PDF-1.4",
      "content/img/a.png": PNG_1X1,
    });
    projects.push(project);
    const message = async (yaml: string) => {
      await project.write("content/kit.yml", yaml);
      const error = await build({ rootDir: project.dir }).catch(
        (cause: unknown) => cause,
      );
      return isAnhurBuildError(error) ? error.message : String(error);
    };
    expect(
      await message("cover: ./img/a.png\nbrochure: ../service-account.json\n"),
    ).toContain("does not allow");
    expect(
      await message(
        "cover: ./img/a.png\nbrochure: ../node_modules/pkg/doc.pdf\n",
      ),
    ).toContain("inside node_modules");
    expect(await message("cover: ./favicon.ico\n")).toContain(
      "Use a.file() for other files",
    );

    await project.write(
      "anhur.config.ts",
      config(
        '{ roots: ["node_modules/pkg"], extensions: [...DEFAULT_ASSET_EXTENSIONS, ...DOCUMENT_ASSET_EXTENSIONS] }',
      ).replace(
        "import { assets, schema as a }",
        "import { assets, DEFAULT_ASSET_EXTENSIONS, DOCUMENT_ASSET_EXTENSIONS, schema as a }",
      ),
    );
    await project.write(
      "content/kit.yml",
      "cover: ./img/a.png\nbrochure: ../node_modules/pkg/doc.pdf\n",
    );
    await build({ rootDir: project.dir });
    expect(await project.read(".anhur/generated/allProducts.js")).toMatch(
      /"brochure":\{"src":"\/anhur-assets\/doc-[0-9a-f]{16}\.pdf"/,
    );
  });

  it("accepts a root inside a dot-folder", async () => {
    const project = await createProject({
      "anhur.config.ts": config('{ roots: [".shared"] }'),
      ".shared/img/a.png": PNG_1X1,
      "content/kit.yml": "cover: ../.shared/img/a.png\n",
    });
    projects.push(project);
    await build({ rootDir: project.dir });
    expect(await project.read(".anhur/generated/allProducts.js")).toMatch(
      /"cover":\{"src":"\/anhur-assets\/a-[0-9a-f]{16}\.png"/,
    );
  });

  it("reads assets when the project path is spelled with another case", async () => {
    const project = await createProject({
      "anhur.config.ts": config("{}"),
      "content/img/a.png": PNG_1X1,
      "content/kit.yml": "cover: ./img/a.png\n",
    });
    projects.push(project);
    const upper = project.dir.toUpperCase();
    const caseInsensitive = await readdir(upper).then(
      () => true,
      () => false,
    );
    if (!caseInsensitive) return;
    const result = await build({ rootDir: upper });
    expect(result.assets?.count).toBe(1);
  });

  it("keeps only http(s) and root URLs with allowRemote", async () => {
    const project = await createProject({
      "anhur.config.ts": config("{}"),
      "content/img/a.png": PNG_1X1,
    });
    projects.push(project);
    for (const hero of ["javascript:alert(1)", "data:text/html,x", "#x"]) {
      await project.write(
        "content/kit.yml",
        `cover: ./img/a.png\nhero: "${hero}"\n`,
      );
      const error = await build({ rootDir: project.dir }).catch(
        (cause: unknown) => cause,
      );
      expect(isAnhurBuildError(error) && error.message, hero).toContain(
        "keeps only http(s) URLs",
      );
    }
    await project.write(
      "content/kit.yml",
      'cover: ./img/a.png\nhero: " //cdn.example.com/x.png"\n',
    );
    await build({ rootDir: project.dir });
    expect(await project.read(".anhur/generated/allProducts.js")).toContain(
      '"hero":{"src":"//cdn.example.com/x.png","remote":true}',
    );
  });

  it("reports unusable bases and storage options at config time", async () => {
    const cases: readonly (readonly [string, string])[] = [
      ['{ base: "/" }', "must not be the site root"],
      ['{ base: "/a/../b/" }', '".." segments'],
      [
        '{ base: "https://", storage: { prefix: "site", files: {} as never } }',
        "is not a valid URL",
      ],
      [
        '{ base: "https://cdn.example.com/site/", storage: { prefix: "site", concurrency: Number.NaN, files: {} as never } }',
        "storage.concurrency must be a whole number",
      ],
    ];
    for (const [options, expected] of cases) {
      const project = await createProject({
        "anhur.config.ts": config(options),
        "content/kit.yml": "cover: ./a.png\n",
      });
      projects.push(project);
      const error = await build({ rootDir: project.dir }).catch(
        (cause: unknown) => cause,
      );
      expect(isAnhurBuildError(error) && error.message, options).toContain(
        expected,
      );
    }
  });

  it("never prunes storage in dev and only prunes its own keys after a build", async () => {
    const storageConfig = (prune: string) =>
      config(
        `{ base: "https://cdn.example.com/site/", storage: { prefix: "site", syncInDev: true, ${prune} files: store } }`,
      ).replace(
        "export default",
        `const keys: Set<string> = ((globalThis as { anhurStore?: Set<string> }).anhurStore ??= new Set());
const store = {
  upload: async (key: string) => { keys.add(key); },
  exists: async (key: string) => keys.has(key),
  delete: async (batch: string | string[]) => { for (const key of [batch].flat()) keys.delete(key); },
  listAll: async function* () { for (const key of [...keys]) yield { key }; },
};
export default`,
      );
    const keys = new Set([
      "site/old-0123456789abcdef.png",
      "site/uploads/user-photo.jpg",
      "site/preview/branch-x-0123456789abcdef.png",
    ]);
    // SAFETY: the test config reads this global in the same process.
    const store = globalThis as { anhurStore?: Set<string> };
    store.anhurStore = keys;
    try {
      const project = await createProject({
        "anhur.config.ts": storageConfig("prune: true,"),
        "content/img/a.png": PNG_1X1,
        "content/kit.yml": "cover: ./img/a.png\n",
      });
      projects.push(project);
      await build({ rootDir: project.dir, mode: "dev" });
      expect(keys.has("site/old-0123456789abcdef.png")).toBe(true);
      expect(keys.size).toBe(4);

      await build({ rootDir: project.dir });
      const uploaded = [...keys].filter((key) =>
        /^site\/a-[0-9a-f]{16}\.png$/.test(key),
      );
      expect(uploaded).toHaveLength(1);
      expect([...keys].sort()).toEqual(
        [
          "site/preview/branch-x-0123456789abcdef.png",
          "site/uploads/user-photo.jpg",
          ...uploaded,
        ].sort(),
      );
    } finally {
      delete store.anhurStore;
    }
  });
});
