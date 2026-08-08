import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../../src/build";

const fixturesRoot = path.join(import.meta.dirname, "../fixtures");
const fixtureName = "codegen-views";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("codegen views", () => {
  afterEach(async () => {
    await rm(path.join(fixturesRoot, fixtureName, ".anhur"), {
      recursive: true,
      force: true,
    });
  });

  it("emits filtered lists, indexes, and groups", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, fixtureName),
    });

    const featuredPath = path.join(result.outputDir, "allFeaturedPosts.js");
    expect(await exists(featuredPath)).toBe(true);
    expect(
      await exists(path.join(result.outputDir, "getFeaturedPost.js")),
    ).toBe(false);

    const featuredPosts = (
      await import(`${pathToFileURL(featuredPath).href}?t=${Date.now()}`)
    ).default as Array<{ slug: string; featured?: boolean; body?: string }>;

    expect(featuredPosts.map((p) => p.slug)).toEqual(["alpha"]);
    expect(featuredPosts[0]!.body).toBeUndefined();

    const productsPath = path.join(result.outputDir, "spotlightProducts.js");
    const spotlight = (
      await import(`${pathToFileURL(productsPath).href}?t=${Date.now()}`)
    ).default as Array<{ sku: string; price: string }>;
    // limit: 1 after price asc among featured → PRO (99) before PRO2 (149)
    expect(spotlight.map((p) => p.sku)).toEqual(["PRO"]);

    const feedPath = path.join(result.outputDir, "allSiteFeed.js");
    const feed = (
      await import(`${pathToFileURL(feedPath).href}?t=${Date.now()}`)
    ).default as Array<{ collection: string; slug: string; href: string }>;
    expect(feed.map((item) => item.slug).sort()).toEqual([
      "about",
      "alpha",
      "beta",
    ]);

    const bySkuPath = path.join(result.outputDir, "productBySku.js");
    const bySku = (
      await import(`${pathToFileURL(bySkuPath).href}?t=${Date.now()}`)
    ).default as Record<string, { name: string; sku: string; price: string }>;
    expect(bySku.PRO).toMatchObject({ name: "Pro Kit", price: "99" });
    expect(bySku.START?.sku).toBe("START");

    const byCategoryPath = path.join(result.outputDir, "productsByCategory.js");
    const byCategory = (
      await import(`${pathToFileURL(byCategoryPath).href}?t=${Date.now()}`)
    ).default as Array<{
      key: string;
      count: number;
      items: Array<{ sku: string; price: string }>;
    }>;
    expect(byCategory.map((g) => g.key)).toEqual(["pro", "starter"]);
    const pro = byCategory.find((g) => g.key === "pro")!;
    expect(pro.count).toBe(2);
    expect(pro.items.map((i) => i.sku)).toEqual(["PRO", "PRO2"]);

    const dts = await readFile(
      path.join(result.outputDir, "index.d.ts"),
      "utf8",
    );
    expect(dts).toContain("GetViewByName");
    expect(dts).toContain(
      "export declare const allFeaturedPosts: Array<FeaturedPost>;",
    );
    expect(dts).toContain("export declare const productBySku:");
    expect(dts).toContain("ProductBySkuKey");
    expect(dts).toContain(
      'export type ProductBySkuKey = "PRO" | "PRO2" | "START"',
    );
    expect(dts).toContain("Record<ProductBySkuKey,");
    expect(dts).toContain("export declare const productsByCategory:");
    expect(dts).toContain("ProductsByCategoryKey");
    expect(dts).toContain("count: number");
    // item vs array names must not collide
    expect(dts).toMatch(
      /export type ProductsByCategoryGroup = \{ key: ProductsByCategoryKey/,
    );
    expect(dts).not.toMatch(
      /export type ProductsByCategory = GetViewByName[\s\S]*export type ProductsByCategory = Array/,
    );
    const index = await readFile(
      path.join(result.outputDir, "index.js"),
      "utf8",
    );
    expect(index).toContain(
      'export { default as productBySku } from "./productBySku.js";',
    );
    expect(index).toContain(
      'export { default as productsByCategory } from "./productsByCategory.js";',
    );
  });
});
