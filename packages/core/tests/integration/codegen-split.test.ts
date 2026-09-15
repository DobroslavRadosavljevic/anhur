import { access, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { build } from "../../src/build";

const fixturesRoot = path.join(import.meta.dirname, "../fixtures");
const fixtureName = "codegen-split";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("codegen list/document split", () => {
  afterEach(async () => {
    await rm(path.join(fixturesRoot, fixtureName, ".anhur"), {
      recursive: true,
      force: true,
    });
  });

  it("emits light allPosts without body and full documents via getPost", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, fixtureName),
    });

    const listPath = path.join(result.outputDir, "allPosts.js");
    const listSource = await readFile(listPath, "utf8");
    expect(listSource).not.toContain("BODY_ALPHA_UNIQUE_MARKER");
    expect(listSource).not.toContain("BODY_BETA_UNIQUE_MARKER");
    expect(listSource).toContain("Alpha");

    // SAFETY: preserves the existing runtime contract for this assignment.
    const allPosts = (
      await import(`${pathToFileURL(listPath).href}?t=${Date.now()}`)
    ).default as Array<{
      title: string;
      body?: string;
      slug: string;
      _meta: { id: string; locale?: string };
    }>;

    expect(allPosts).toHaveLength(3);
    for (const post of allPosts) {
      expect(post.body).toBeUndefined();
    }

    const { getPost } = await import(
      `${pathToFileURL(path.join(result.outputDir, "getPost.js")).href}?t=${Date.now()}`
    );

    const full = await getPost({ locale: "en", slug: "alpha" });
    expect(full.title).toBe("Alpha");
    expect(full.body).toContain("BODY_ALPHA_UNIQUE_MARKER");

    const byId = await getPost({ locale: "en", id: "alpha" });
    expect(byId.body).toContain("BODY_ALPHA_UNIQUE_MARKER");

    const de = await getPost({ locale: "de", slug: "alpha" });
    expect(de.body).toContain("BODY_ALPHA_DE_MARKER");
  });

  it("keeps list module much smaller than full document modules", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, fixtureName),
    });

    const listPath = path.join(result.outputDir, "allPosts.js");
    const listSource = await readFile(listPath, "utf8");
    expect(listSource).not.toContain("BODY_ALPHA_UNIQUE_MARKER");
    expect(listSource).not.toContain("ALPHA_PAD_001");

    const listBytes = (await stat(listPath)).size;
    const docDir = path.join(result.outputDir, "documents", "posts");
    const docsTotal =
      (await stat(path.join(docDir, "en__alpha.js"))).size +
      (await stat(path.join(docDir, "en__beta.js"))).size +
      (await stat(path.join(docDir, "de__alpha.js"))).size;

    expect(listBytes).toBeLessThan(docsTotal);
    // Bodies dominate document modules once content is non-trivial.
    expect(listBytes).toBeLessThan(docsTotal * 0.85);
  });

  it("uses tree-shakeable re-exports in index.js", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, fixtureName),
    });
    const index = await readFile(
      path.join(result.outputDir, "index.js"),
      "utf8",
    );

    expect(index).toContain(
      'export { default as allPosts } from "./allPosts.js";',
    );
    expect(index).toContain('export { getPost } from "./getPost.js";');
    expect(index).not.toMatch(/^import allPosts from/m);
  });

  it("declares list vs full types and getPost in index.d.ts", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, fixtureName),
    });
    const dts = await readFile(
      path.join(result.outputDir, "index.d.ts"),
      "utf8",
    );

    expect(dts).toContain("export type Post = GetTypeByName<");
    expect(dts).toContain(
      'export type PostListItem = OmitListFields<Post, "body">;',
    );
    expect(dts).toContain("export type Posts = Array<Post>;");
    expect(dts).toContain(
      "export declare const allPosts: Array<PostListItem>;",
    );
    expect(dts).toContain('export type Locale = "de" | "en";');
    expect(dts).toContain(
      'export declare const locales: readonly ["en", "de"];',
    );
    expect(dts).toContain('export declare const defaultLocale: "en";');
    expect(dts).not.toContain(
      "export declare function getPost(idOrSlug: string): Promise<Post | null>;",
    );
    expect(dts).toContain(
      "export declare function getPost(query: { locale: Locale; id?: string; slug?: string }): Promise<Post | null>;",
    );
  });

  it("accepts string id/slug and returns null when missing", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, fixtureName),
    });

    const { getPost } = await import(
      `${pathToFileURL(path.join(result.outputDir, "getPost.js")).href}?t=${Date.now()}`
    );

    // Runtime still accepts a bare slug (first match); typed API requires locale.
    const bySlug = await getPost("alpha");
    expect(bySlug.title).toBe("Alpha");
    expect(bySlug.body).toContain("BODY_ALPHA_UNIQUE_MARKER");

    const missing = await getPost("does-not-exist");
    expect(missing).toBeNull();

    const missingQuery = await getPost({ locale: "en", slug: "nope" });
    expect(missingQuery).toBeNull();
  });

  it("emits locales runtime module and re-exports", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, fixtureName),
    });

    expect(await exists(path.join(result.outputDir, "locales.js"))).toBe(true);

    const { locales, defaultLocale } = await import(
      `${pathToFileURL(path.join(result.outputDir, "locales.js")).href}?t=${Date.now()}`
    );
    expect(locales).toEqual(["en", "de"]);
    expect(defaultLocale).toBe("en");

    const index = await readFile(
      path.join(result.outputDir, "index.js"),
      "utf8",
    );
    expect(index).toContain(
      'export { locales, defaultLocale } from "./locales.js";',
    );
  });

  it("emits project-relative _meta.filePath", async () => {
    const rootDir = path.join(fixturesRoot, fixtureName);
    const result = await build({ rootDir });
    const listSource = await readFile(
      path.join(result.outputDir, "allPosts.js"),
      "utf8",
    );
    expect(listSource).not.toContain(rootDir);
    expect(listSource).toMatch(/"filePath":\s*"content\//);
  });

  it("types light list items without body at compile time", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, fixtureName),
    });

    type Post = {
      title: string;
      slug: string;
      body: string;
      _meta: { id: string };
    };
    type PostListItem = Omit<Post, "body">;

    // SAFETY: preserves the existing runtime contract for this assignment.

    const allPosts = (
      await import(
        `${pathToFileURL(path.join(result.outputDir, "allPosts.js")).href}?t=${Date.now()}`
      )
    ).default as PostListItem[];

    // SAFETY: preserves the existing runtime contract for this assignment.
    expectTypeOf(allPosts[0]!).toMatchTypeOf<PostListItem>();
    expectTypeOf(allPosts[0]!).not.toHaveProperty("body");

    // SAFETY: preserves the existing runtime contract for this assignment.
    const { getPost } = (await import(
      `${pathToFileURL(path.join(result.outputDir, "getPost.js")).href}?t=${Date.now()}`
    )) as {
      getPost: (
        q: string | { locale?: string; slug?: string },
      ) => Promise<Post | null>;
    };

    const post = await getPost({ locale: "en", slug: "beta" });
    expect(post).not.toBeNull();
    expectTypeOf(post!).toMatchTypeOf<Post>();
    expect(post!.body).toContain("BODY_BETA_UNIQUE_MARKER");
  });
});
