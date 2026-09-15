import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearIntegrationHandlers,
  defineCollection,
  schema as s,
} from "@anhur/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildOramaIndex } from "../../src/build";
import { createSearcher, isAnhurOramaIndex } from "../../src/client";
import {
  createOramaIntegration,
  ensureOramaRegistered,
} from "../../src/integration";
import type { OramaIntegrationOptions } from "../../src/types";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  localized: false,
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    excerpt: s.string().optional(),
  }),
});

const products = defineCollection({
  name: "products",
  directory: "content/products",
  include: "**/*.json",
  localized: false,
  schema: s.object({
    name: s.string(),
    sku: s.string(),
  }),
});

const content = [posts, products] as const;

afterEach(() => {
  clearIntegrationHandlers();
  ensureOramaRegistered();
});

describe("orama integration", () => {
  it("builds an index and restores searchable hits with store payloads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "anhur-orama-"));
    const outputDir = path.join(root, ".anhur", "generated");
    await mkdir(outputDir, { recursive: true });

    const options = {
      collections: {
        posts: {
          schema: {
            title: "string" as const,
            excerpt: "string" as const,
          },
          index: (doc: {
            title: string;
            excerpt?: string;
            slug: string;
            _meta: { locale?: string };
          }) => ({
            title: doc.title,
            excerpt: doc.excerpt ?? "",
          }),
          store: (doc: {
            title: string;
            slug: string;
            _meta: { locale?: string };
          }) => ({
            title: doc.title,
            slug: doc.slug,
            href: `/posts/${doc._meta.locale}/${doc.slug}`,
          }),
        },
        products: {
          schema: {
            name: "string" as const,
            sku: "string" as const,
          },
          index: (doc: { name: string; sku: string }) => ({
            name: doc.name,
            sku: doc.sku,
          }),
          store: (doc: { name: string; sku: string }) => ({
            name: doc.name,
            sku: doc.sku,
            href: "/products",
          }),
        },
      },
    } satisfies OramaIntegrationOptions<typeof content>;

    const entry = createOramaIntegration(options);
    expect(entry.id).toBe("orama");

    await buildOramaIndex(entry, {
      rootDir: root,
      outputDir,
      config: { content },
      sources: [
        {
          name: "posts",
          type: "collection",
          documents: [
            {
              title: "Hello Orama",
              slug: "hello-orama",
              excerpt: "Fast full text search",
              _meta: {
                id: "hello-orama",
                filePath: "/tmp/hello.md",
                relativePath: "en/hello-orama.md",
                extension: ".md",
                locale: "en",
              },
            },
          ],
        },
        {
          name: "products",
          type: "collection",
          documents: [
            {
              name: "Wireless Headphones",
              sku: "WH-100",
              _meta: {
                id: "wh-100",
                filePath: "/tmp/wh.json",
                relativePath: "wh-100.json",
                extension: ".json",
              },
            },
          ],
        },
      ],
    });

    const raw = await readFile(
      path.join(outputDir, "search", "orama.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    if (!isAnhurOramaIndex(parsed)) {
      throw new Error("expected AnhurOramaIndex");
    }
    const snapshot = parsed;
    expect(snapshot.version).toBe(2);
    expect(snapshot.collections).toEqual(["posts", "products"]);
    expect(snapshot.documents.length).toBe(2);

    const searcher = await createSearcher(snapshot);
    const globalHits = await searcher.search({ term: "orama" });
    expect(globalHits.count).toBeGreaterThan(0);
    expect(globalHits.hits[0]?.store).toMatchObject({
      title: "Hello Orama",
      slug: "hello-orama",
    });

    const productHits = await searcher.searchCollection("products", {
      term: "headphones",
    });
    expect(productHits.count).toBeGreaterThan(0);
    expect(productHits.hits[0]?.store).toMatchObject({ sku: "WH-100" });
  });

  it("writes an empty searchable index when collections have no documents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "anhur-orama-empty-"));
    const outputDir = path.join(root, "out");
    await mkdir(outputDir, { recursive: true });

    const options = {
      collections: {
        posts: {
          schema: { title: "string" as const },
          index: (doc: { title: string }) => ({ title: doc.title }),
        },
      },
    } satisfies OramaIntegrationOptions<readonly [typeof posts]>;

    await buildOramaIndex(createOramaIntegration(options), {
      rootDir: root,
      outputDir,
      config: { content: [posts] },
      sources: [{ name: "posts", type: "collection", documents: [] }],
    });

    const parsed = JSON.parse(
      await readFile(path.join(outputDir, "search", "orama.json"), "utf8"),
    );
    if (!isAnhurOramaIndex(parsed)) {
      throw new Error("expected AnhurOramaIndex");
    }
    const snapshot = parsed;
    const searcher = await createSearcher(snapshot);
    expect((await searcher.search({ term: "anything" })).count).toBe(0);

    await writeFile(
      path.join(root, "copy.json"),
      JSON.stringify(snapshot),
      "utf8",
    );
  });
});
