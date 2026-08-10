import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../../src/build";

const fixturesRoot = path.join(import.meta.dirname, "../fixtures");
const fixtureName = "codegen-generate";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("codegen generate options", () => {
  afterEach(async () => {
    await rm(path.join(fixturesRoot, fixtureName, ".anhur"), {
      recursive: true,
      force: true,
    });
  });

  it("renames exports, sorts lists, and emits id/slug unions", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, fixtureName),
    });

    const listPath = path.join(result.outputDir, "posts.js");
    expect(await exists(listPath)).toBe(true);
    expect(await exists(path.join(result.outputDir, "allPosts.js"))).toBe(
      false,
    );

    const posts = (
      await import(`${pathToFileURL(listPath).href}?t=${Date.now()}`)
    ).default as Array<{ slug: string; date: string; body?: string }>;

    expect(posts.map((p) => p.slug)).toEqual(["newer", "older", "older"]);
    expect(posts[0]!.date).toBe("2025-06-01");
    for (const post of posts) {
      expect(post.body).toBeUndefined();
    }

    const { loadPost } = await import(
      `${pathToFileURL(path.join(result.outputDir, "loadPost.js")).href}?t=${Date.now()}`
    );
    const full = await loadPost({ locale: "en", slug: "newer" });
    expect(full.body).toContain("BODY_NEWER");

    const dts = await readFile(
      path.join(result.outputDir, "index.d.ts"),
      "utf8",
    );
    expect(dts).toContain("export type PostSummary = OmitListFields<Post,");
    expect(dts).toContain("export type PostList = Array<Post>;");
    expect(dts).toContain('export type PostId = "newer" | "older";');
    expect(dts).toContain('export type PostSlug = "newer" | "older";');
    expect(dts).toContain("export declare const posts: Array<PostSummary>;");
    expect(dts).toContain("export type Locale =");
    expect(dts).toContain("export declare const locales:");
    expect(dts).toContain("export declare const defaultLocale:");
    expect(dts).not.toContain(
      "export declare function loadPost(idOrSlug: string): Promise<Post | null>;",
    );
    expect(dts).toContain(
      "export declare function loadPost(query: { locale: Locale; id?: string; slug?: string }): Promise<Post | null>;",
    );

    const index = await readFile(
      path.join(result.outputDir, "index.js"),
      "utf8",
    );
    expect(index).toContain('export { default as posts } from "./posts.js";');
    expect(index).toContain('export { loadPost } from "./loadPost.js";');
  });

  it("supports list-only split without documents or getter", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, fixtureName),
    });

    expect(await exists(path.join(result.outputDir, "allProducts.js"))).toBe(
      true,
    );
    expect(await exists(path.join(result.outputDir, "getProduct.js"))).toBe(
      false,
    );
    expect(
      await exists(path.join(result.outputDir, "documents", "products")),
    ).toBe(false);

    const products = (
      await import(
        `${pathToFileURL(path.join(result.outputDir, "allProducts.js")).href}?t=${Date.now()}`
      )
    ).default as Array<{ sku: string; name: string }>;

    expect(products).toHaveLength(2);
    expect(products.map((p) => p.sku).sort()).toEqual(["kit-01", "pro-01"]);

    const dts = await readFile(
      path.join(result.outputDir, "index.d.ts"),
      "utf8",
    );
    expect(dts).toContain('export type ProductId = "kit" | "pro";');
    expect(dts).not.toContain("getProduct");
    expect(dts).toContain("export type ProductListItem = Product;");
  });

  it("keeps full bodies on the list when split is full", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, fixtureName),
    });

    expect(await exists(path.join(result.outputDir, "getNote.js"))).toBe(false);
    expect(
      await exists(path.join(result.outputDir, "documents", "notes")),
    ).toBe(false);

    const notes = (
      await import(
        `${pathToFileURL(path.join(result.outputDir, "allNotes.js")).href}?t=${Date.now()}`
      )
    ).default as Array<{ title: string; body: string }>;

    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain("NOTE_BODY_INLINE");

    const dts = await readFile(
      path.join(result.outputDir, "index.d.ts"),
      "utf8",
    );
    expect(dts).toContain("export type NoteListItem = Note;");
    expect(dts).not.toContain("getNote");
  });

  it("looks up full documents by custom lookupBy fields", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, fixtureName),
    });

    const { getInventory } = await import(
      `${pathToFileURL(path.join(result.outputDir, "getInventory.js")).href}?t=${Date.now()}`
    );
    const item = await getInventory({ sku: "w-100" });
    expect(item.name).toBe("Widget");
    expect(item.sku).toBe("w-100");

    const dts = await readFile(
      path.join(result.outputDir, "index.d.ts"),
      "utf8",
    );
    expect(dts).toContain(
      "export declare function getInventory(idOrSlug: string): Promise<Inventory | null>;",
    );
    expect(dts).toContain(
      "export declare function getInventory(query?: { id?: string; sku?: string }): Promise<Inventory | null>;",
    );
  });

  it("emits singleton getter, renamed All, and locale documents", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, fixtureName),
    });

    expect(await exists(path.join(result.outputDir, "settings.js"))).toBe(true);
    expect(await exists(path.join(result.outputDir, "allSettings.js"))).toBe(
      true,
    );
    expect(await exists(path.join(result.outputDir, "settingsAll.js"))).toBe(
      false,
    );
    expect(await exists(path.join(result.outputDir, "loadSettings.js"))).toBe(
      true,
    );

    const settings = (
      await import(
        `${pathToFileURL(path.join(result.outputDir, "settings.js")).href}?t=${Date.now()}`
      )
    ).default as { title: string; body: string };
    expect(settings.title).toBe("Site EN");

    const { loadSettings } = await import(
      `${pathToFileURL(path.join(result.outputDir, "loadSettings.js")).href}?t=${Date.now()}`
    );
    const de = await loadSettings({ locale: "de" });
    expect(de.body).toContain("SETTINGS_DE");

    const dts = await readFile(
      path.join(result.outputDir, "index.d.ts"),
      "utf8",
    );
    expect(dts).toContain("export declare const allSettings: Array<Settings>;");
    expect(dts).toContain(
      "export declare function loadSettings(query: { locale: Locale }): Promise<Settings | null>;",
    );
  });

  it("wipes stale top-level modules on rebuild", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, fixtureName),
    });

    const orphanList = path.join(result.outputDir, "allProviders.js");
    const orphanGetter = path.join(result.outputDir, "getProvider.js");
    await writeFile(orphanList, "// stale orphan\n");
    await writeFile(orphanGetter, "// stale orphan\n");
    expect(await exists(orphanList)).toBe(true);
    expect(await exists(orphanGetter)).toBe(true);

    const rebuilt = await build({
      rootDir: path.join(fixturesRoot, fixtureName),
    });

    expect(await exists(path.join(rebuilt.outputDir, "allProviders.js"))).toBe(
      false,
    );
    expect(await exists(path.join(rebuilt.outputDir, "getProvider.js"))).toBe(
      false,
    );
    expect(await exists(path.join(rebuilt.outputDir, "posts.js"))).toBe(true);
    expect(await exists(path.join(rebuilt.outputDir, "index.js"))).toBe(true);
  });
});
