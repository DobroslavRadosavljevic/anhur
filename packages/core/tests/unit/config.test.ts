import { describe, expect, expectTypeOf, it } from "vitest";
import {
  collectionConstName,
  defineCollection,
  defineConfig,
  defineSingleton,
  generateCollectionArrayTypeName,
  generateDocumentTypeName,
  generateTypeName,
  isCollection,
  isLocalized,
  resolveLocalization,
  singularizePascal,
  singletonConstName,
  type GetTypeByName,
} from "../../src/config";
import { schema as s } from "../../src/schema";

describe("config helpers", () => {
  it("generateTypeName pascal-cases names", () => {
    expect(generateTypeName("blog-posts")).toBe("BlogPosts");
    expect(generateTypeName("settings")).toBe("Settings");
  });

  it("generateDocumentTypeName singularizes collection names", () => {
    expect(generateDocumentTypeName("posts")).toBe("Post");
    expect(generateDocumentTypeName("authors")).toBe("Author");
    expect(generateDocumentTypeName("blog-posts")).toBe("BlogPost");
    expect(generateDocumentTypeName("changelog")).toBe("Changelog");
  });

  it("generateCollectionArrayTypeName builds plural aliases", () => {
    expect(generateCollectionArrayTypeName("posts", "Post")).toBe("Posts");
    expect(generateCollectionArrayTypeName("authors", "Author")).toBe(
      "Authors",
    );
    expect(generateCollectionArrayTypeName("changelog", "Changelog")).toBe(
      "Changelogs",
    );
  });

  it("singularizePascal handles common plurals", () => {
    expect(singularizePascal("Posts")).toBe("Post");
    expect(singularizePascal("Categories")).toBe("Category");
    expect(singularizePascal("Changelog")).toBe("Changelog");
  });

  it("collectionConstName pluralizes exports", () => {
    expect(collectionConstName("posts")).toBe("allPosts");
    expect(collectionConstName("author")).toBe("allAuthors");
  });

  it("singletonConstName keeps the name", () => {
    expect(singletonConstName("settings")).toBe("settings");
  });
});

describe("defineCollection / defineSingleton / defineConfig", () => {
  const zodSchema = s.object({ title: s.string(), content: s.string() });

  const localization = {
    strategy: "folder" as const,
    locales: ["en", "de"] as const,
    defaultLocale: "en",
  };

  it("defines a collection with a Zod schema", () => {
    const posts = defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      schema: zodSchema,
    });

    expect(isCollection(posts)).toBe(true);
    expect(posts.type).toBe("collection");
    expect(posts.typeName).toBe("Post");
  });

  it("uses singular document type names for plural collection names", () => {
    const authors = defineCollection({
      name: "authors",
      directory: "content/authors",
      include: "**/*.yml",
      schema: zodSchema,
    });
    expect(authors.typeName).toBe("Author");
  });

  it("preserves an optional transform on collections", () => {
    const transform = (doc: { title?: unknown }) => ({
      ...doc,
      title: "x",
    });
    const posts = defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      schema: zodSchema,
      transform: transform as never,
    });
    expect(posts.transform).toBe(transform);
  });

  it("rejects non-Zod schemas", () => {
    expect(() =>
      defineCollection({
        name: "posts",
        directory: "content/posts",
        include: "**/*.md",
        schema: { parse: () => ({}) } as never,
      }),
    ).toThrow(/Zod schema/);
  });

  it("defineConfig requires filePath when localization is off", () => {
    expect(() =>
      defineConfig({
        content: [
          defineSingleton({
            name: "settings",
            schema: zodSchema,
          }),
        ],
      }),
    ).toThrow(/filePath/);
  });

  it("defineConfig requires directory when localization is on", () => {
    expect(() =>
      defineConfig({
        localization,
        content: [
          defineSingleton({
            name: "settings",
            schema: zodSchema,
            filePath: "settings.md",
          }),
        ],
      }),
    ).toThrow(/directory/);
  });

  it("isLocalized inherits project localization unless opted out", () => {
    const posts = defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      schema: zodSchema,
    });
    const local = defineCollection({
      name: "local",
      directory: "content/local",
      include: "**/*.md",
      schema: zodSchema,
      localized: false,
    });
    const config = defineConfig({
      localization,
      content: [posts, local],
    });

    expect(isLocalized(config, posts)).toBe(true);
    expect(isLocalized(config, local)).toBe(false);
    expect(resolveLocalization(config, posts)?.defaultLocale).toBe("en");
    expect(resolveLocalization(config, local)).toBeUndefined();
  });

  it("exports schema.raw helper", () => {
    expect(typeof s.raw()).toBe("object");
    expect(typeof s.unique()).toBe("object");
  });

  it("defineConfig preserves source names for GetTypeByName", () => {
    const posts = defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      schema: s.object({ title: s.string() }),
    });
    const config = defineConfig({ content: [posts] });
    type Post = GetTypeByName<typeof config, "posts">;
    expectTypeOf<Post>().toMatchTypeOf<{
      title: string;
      _meta: { id: string };
    }>();
  });
});
