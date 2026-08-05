import { describe, expect, expectTypeOf, it } from "vitest";
import {
  collectDocumentIds,
  collectionGetterName,
  documentLookupKey,
  documentModuleBasename,
  getterQueryTypeFields,
  literalUnionType,
  omitKeysUnionType,
  pickLookupKeyPart,
  resolveCollectionGenerate,
  resolveListOmit,
  resolveSingletonGenerate,
  sortByListSort,
  toListExport,
} from "../../src/codegen";
import { defineCollection, defineSingleton } from "../../src/config";
import { schema as s } from "../../src/schema";

describe("codegen helpers", () => {
  it("names getters from collection names", () => {
    expect(collectionGetterName("posts")).toBe("getPost");
    expect(collectionGetterName("authors")).toBe("getAuthor");
    expect(collectionGetterName("pages")).toBe("getPage");
    expect(collectionGetterName("changelog")).toBe("getChangelog");
    expect(collectionGetterName("products")).toBe("getProduct");
  });

  it("builds locale+id module basenames", () => {
    expect(documentModuleBasename("en", "hello")).toBe("en__hello");
    expect(documentModuleBasename(undefined, "x")).toBe("default__x");
    expect(documentModuleBasename("en", "a/b")).toBe("en__a_b");
  });

  it("defaults listOmit to body", () => {
    expect(resolveListOmit(undefined)).toEqual(["body"]);
    expect(resolveListOmit([])).toEqual([]);
    expect(resolveListOmit(["body", "attachment"])).toEqual([
      "body",
      "attachment",
    ]);
  });

  it("omits list fields from list exports", () => {
    const light = toListExport(
      { title: "T", body: "HEAVY", slug: "t" },
      {
        id: "t",
        filePath: "/t.md",
        relativePath: "t.md",
        extension: ".md",
        locale: "en",
      },
      ["body"],
    );
    expect(light).toMatchObject({ title: "T", slug: "t" });
    expect(light).not.toHaveProperty("body");
    expect(light._meta).toMatchObject({ id: "t", locale: "en" });
  });

  it("formats omit union for d.ts", () => {
    expect(omitKeysUnionType(["body"])).toBe('"body"');
    expect(omitKeysUnionType(["body", "x"])).toBe('"body" | "x"');
  });

  it("builds lookup keys", () => {
    expect(documentLookupKey("en", "hello")).toBe("en:hello");
  });

  it("builds literal unions and getter query fields", () => {
    expect(literalUnionType([])).toBe("never");
    expect(literalUnionType(["b", "a", "a"])).toBe('"a" | "b"');
    expect(getterQueryTypeFields(["slug", "sku"])).toBe(
      "locale?: string; id?: string; slug?: string; sku?: string",
    );
  });

  it("picks lookup key parts in id-then-lookupBy order", () => {
    expect(pickLookupKeyPart({ slug: "s" }, ["slug"])).toBe("s");
    expect(pickLookupKeyPart({ id: "i", slug: "s" }, ["slug"])).toBe("i");
    expect(pickLookupKeyPart({ sku: "x" }, ["slug", "sku"])).toBe("x");
    expect(pickLookupKeyPart({}, ["slug"])).toBeUndefined();
  });

  it("sorts list items by field", () => {
    const items = [{ date: "2024-01-01" }, { date: "2025-01-01" }];
    expect(
      sortByListSort(items, { by: "date", order: "desc" }).map((i) => i.date),
    ).toEqual(["2025-01-01", "2024-01-01"]);
    expect(
      sortByListSort(items, { by: "date", order: "asc" }).map((i) => i.date),
    ).toEqual(["2024-01-01", "2025-01-01"]);
  });

  it("collects document ids", () => {
    expect(
      collectDocumentIds([
        {
          _meta: {
            id: "a",
            filePath: "",
            relativePath: "",
            extension: ".md",
          },
        },
      ]),
    ).toEqual(["a"]);
  });
});

describe("resolveCollectionGenerate", () => {
  const schema = s.object({ title: s.string() });

  it("defaults to light split with derived names", () => {
    const posts = defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      schema,
    });
    const gen = resolveCollectionGenerate(posts);
    expect(gen.listName).toBe("allPosts");
    expect(gen.getterName).toBe("getPost");
    expect(gen.listItemTypeName).toBe("PostListItem");
    expect(gen.arrayTypeName).toBe("Posts");
    expect(gen.split).toBe("light");
    expect(gen.listOmit).toEqual(["body"]);
    expect(gen.lookupBy).toEqual(["slug"]);
    expect(gen.emitDocuments).toBe(true);
    expect(gen.emitIds).toBe(false);
  });

  it("honors generate overrides and full split clears omit", () => {
    const posts = defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      schema,
      listOmit: ["body"],
      generate: {
        listName: "posts",
        getterName: "loadPost",
        arrayTypeName: "PostList",
        listItemTypeName: "PostSummary",
        split: "full",
        lookupBy: ["sku"],
        emitIds: true,
        emitSlugs: true,
        listSort: { by: "title", order: "asc" },
      },
    });
    const gen = resolveCollectionGenerate(posts);
    expect(gen.listName).toBe("posts");
    expect(gen.getterName).toBe("loadPost");
    expect(gen.arrayTypeName).toBe("PostList");
    expect(gen.listItemTypeName).toBe("PostSummary");
    expect(gen.listOmit).toEqual([]);
    expect(gen.emitDocuments).toBe(false);
    expect(gen.lookupBy).toEqual(["sku"]);
    expect(gen.emitIds).toBe(true);
    expect(gen.emitSlugs).toBe(true);
  });

  it("list-only keeps omit and skips documents", () => {
    const authors = defineCollection({
      name: "authors",
      directory: "content/authors",
      include: "**/*.yml",
      schema,
      generate: { split: "list-only", listOmit: [] },
    });
    const gen = resolveCollectionGenerate(authors);
    expect(gen.emitDocuments).toBe(false);
    expect(gen.listOmit).toEqual([]);
  });

  it("generate.listOmit overrides top-level listOmit", () => {
    const posts = defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      schema,
      listOmit: ["body"],
      generate: { listOmit: ["body", "cover"] },
    });
    expect(resolveCollectionGenerate(posts).listOmit).toEqual([
      "body",
      "cover",
    ]);
  });
});

describe("resolveSingletonGenerate", () => {
  const schema = s.object({ title: s.string() });

  it("defaults for localized singletons", () => {
    const settings = defineSingleton({
      name: "settings",
      directory: "content/settings",
      schema,
    });
    const gen = resolveSingletonGenerate(settings, true);
    expect(gen.exportName).toBe("settings");
    expect(gen.getterName).toBe("getSettings");
    expect(gen.variantsName).toBe("settingsAll");
    expect(gen.emitAll).toBe(true);
    expect(gen.emitDocuments).toBe(true);
  });

  it("honors overrides and emitAll false", () => {
    const settings = defineSingleton({
      name: "settings",
      directory: "content/settings",
      schema,
      generate: {
        exportName: "siteSettings",
        getterName: "loadSettings",
        variantsName: "allSettings",
        emitAll: false,
        split: "list-only",
      },
    });
    const gen = resolveSingletonGenerate(settings, true);
    expect(gen.exportName).toBe("siteSettings");
    expect(gen.getterName).toBe("loadSettings");
    expect(gen.variantsName).toBe("allSettings");
    expect(gen.emitAll).toBe(false);
    expect(gen.emitDocuments).toBe(false);
  });

  it("never emits All when not localized", () => {
    const about = defineSingleton({
      name: "about",
      filePath: "about.md",
      schema,
      generate: { emitAll: true },
    });
    expect(resolveSingletonGenerate(about, false).emitAll).toBe(false);
  });
});

describe("codegen type helpers", () => {
  it("collectionGetterName return type is string", () => {
    expectTypeOf(collectionGetterName("posts")).toEqualTypeOf<string>();
  });
});
