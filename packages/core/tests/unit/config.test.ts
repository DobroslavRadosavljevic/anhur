import { describe, expect, expectTypeOf, it } from "vitest";
import {
  collectionConstName,
  defineCollection,
  defineConfig,
  defineGroup,
  defineIndex,
  defineSingleton,
  defineView,
  generateCollectionArrayTypeName,
  generateDocumentTypeName,
  generateTypeName,
  isCollection,
  isGroup,
  isIndex,
  isLocalized,
  isView,
  resolveLocalization,
  singularizePascal,
  singletonConstName,
  type GetTypeByName,
  type GetViewByName,
} from "../../src/config";
import { schema as s } from "../../src/schema";
import type { TocEntry } from "../../src/schema/toc";

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
    expect(generateDocumentTypeName("use_cases")).toBe("UseCase");
    expect(generateDocumentTypeName("blog_categories")).toBe("BlogCategory");
    expect(generateDocumentTypeName("blog_posts")).toBe("BlogPost");
    expect(generateDocumentTypeName("companies")).toBe("Company");
    expect(generateDocumentTypeName("proxies")).toBe("Proxy");
    expect(generateDocumentTypeName("classes")).toBe("Class");
    expect(generateDocumentTypeName("statuses")).toBe("Status");
    expect(generateDocumentTypeName("buses")).toBe("Bus");
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

  it("singularizePascal handles common and irregular plurals", () => {
    expect(singularizePascal("Posts")).toBe("Post");
    expect(singularizePascal("Categories")).toBe("Category");
    expect(singularizePascal("Changelog")).toBe("Changelog");
    expect(singularizePascal("UseCases")).toBe("UseCase");
    expect(singularizePascal("Classes")).toBe("Class");
    expect(singularizePascal("Statuses")).toBe("Status");
    expect(singularizePascal("Buses")).toBe("Bus");
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

  it("remaps embed:true references to the target document type", () => {
    const authors = defineCollection({
      name: "authors",
      directory: "content/authors",
      include: "**/*.yml",
      localized: false,
      schema: s.object({
        name: s.string(),
        role: s.string(),
      }),
    });
    const posts = defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      localized: false,
      schema: s.object({
        title: s.string(),
        author: s.reference("authors", { embed: true }),
        authorId: s.reference("authors"),
      }),
    });
    const config = defineConfig({ content: [authors, posts] });

    type Post = GetTypeByName<typeof config, "posts">;
    expectTypeOf<Post["authorId"]>().toEqualTypeOf<string>();
    expectTypeOf<Post["author"]>().toMatchTypeOf<{
      name: string;
      role: string;
      _meta: { id: string };
    }>();
  });

  it("keeps TocEntry named through GetTypeByName (no anonymous items: …[])", () => {
    const posts = defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      schema: s.object({
        title: s.string(),
        toc: s.toc(),
      }),
    });
    const config = defineConfig({ content: [posts] });
    type Post = GetTypeByName<typeof config, "posts">;

    expectTypeOf<Post["toc"]>().toEqualTypeOf<TocEntry[]>();
    expectTypeOf<Post["toc"][number]["items"]>().toEqualTypeOf<TocEntry[]>();
  });

  it("keeps TocEntry named even when another field embeds a reference", () => {
    const authors = defineCollection({
      name: "authors",
      directory: "content/authors",
      include: "**/*.yml",
      localized: false,
      schema: s.object({ name: s.string() }),
    });
    const posts = defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      localized: false,
      schema: s.object({
        title: s.string(),
        toc: s.toc(),
        author: s.reference("authors", { embed: true }),
      }),
    });
    const config = defineConfig({ content: [authors, posts] });
    type Post = GetTypeByName<typeof config, "posts">;

    expectTypeOf<Post["toc"]>().toEqualTypeOf<TocEntry[]>();
    expectTypeOf<Post["author"]>().toMatchTypeOf<{
      name: string;
      _meta: { id: string };
    }>();
  });

  it("includes collection transform fields in GetTypeByName", () => {
    const posts = defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      schema: s.object({
        title: s.string(),
      }),
      transform: (doc) => ({
        ...doc,
        relatedCount: 2,
      }),
    });
    const config = defineConfig({ content: [posts] });
    type Post = GetTypeByName<typeof config, "posts">;
    expectTypeOf<Post["relatedCount"]>().toEqualTypeOf<number>();
    expectTypeOf<Post["title"]>().toEqualTypeOf<string>();
  });
});

describe("defineView", () => {
  const posts = defineCollection({
    name: "posts",
    directory: "content/posts",
    include: "**/*.md",
    schema: s.object({
      title: s.string(),
      featured: s.boolean().optional(),
    }),
  });

  const pages = defineCollection({
    name: "pages",
    directory: "content/pages",
    include: "**/*.md",
    schema: s.object({
      title: s.string(),
    }),
  });

  it("defines a filtered single-source view", () => {
    const featuredPosts = defineView({
      name: "featuredPosts",
      from: posts,
      where: (doc): doc is typeof doc & { featured: true } =>
        doc.featured === true,
    });

    expect(isView(featuredPosts)).toBe(true);
    expect(featuredPosts.type).toBe("view");
    expect(featuredPosts.typeName).toBe("FeaturedPost");
    expect(featuredPosts.from.map((c) => c.name)).toEqual(["posts"]);
  });

  it("requires select when merging collections", () => {
    expect(() =>
      defineView({
        name: "feed",
        from: [posts, pages],
        // @ts-expect-error select is required for multi-source views
        select: undefined,
      }),
    ).toThrow(/requires select/);
  });

  it("rejects unknown collections in defineConfig views", () => {
    const orphan = defineCollection({
      name: "orphan",
      directory: "content/orphan",
      include: "**/*.md",
      schema: s.object({ title: s.string() }),
    });
    const dangling = defineView({
      name: "dangling",
      from: orphan,
      where: () => true,
    });

    expect(() =>
      defineConfig({
        content: [posts],
        views: [dangling],
      }),
    ).toThrow(/not in content/);
  });

  it("infers GetViewByName from select return type", () => {
    const feed = defineView({
      name: "siteFeed",
      from: [posts, pages],
      select: (doc) => ({
        collection: doc.collection,
        title: doc.title,
      }),
    });
    const config = defineConfig({
      content: [posts, pages],
      views: [feed],
    });

    type Item = GetViewByName<typeof config, "siteFeed">;
    expectTypeOf<Item>().toEqualTypeOf<{
      collection: "posts" | "pages";
      title: string;
    }>();
  });

  it("defines indexes and groups", () => {
    const bySlug = defineIndex({
      name: "postBySlug",
      from: posts,
      key: "title",
    });
    const byFeatured = defineGroup({
      name: "postsByFeatured",
      from: posts,
      by: (doc) => (doc.featured === true ? "yes" : "no"),
    });

    expect(isIndex(bySlug)).toBe(true);
    expect(isGroup(byFeatured)).toBe(true);

    const config = defineConfig({
      content: [posts],
      views: [bySlug, byFeatured],
    });
    type Indexed = GetViewByName<typeof config, "postBySlug">;
    expectTypeOf<Indexed["title"]>().toEqualTypeOf<string>();
  });
});
