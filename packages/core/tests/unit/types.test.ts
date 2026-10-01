import { describe, expectTypeOf, it } from "vitest";
import {
  createDerivedHelpers,
  defineCollection,
  defineConfig,
  defineView,
  schema as s,
  type GetTypeByName,
  type GetViewByName,
} from "../../src";

const authors = defineCollection({
  name: "authors",
  directory: "authors",
  include: "*.yml",
  localized: false,
  schema: s.object({ name: s.string() }),
  transform: (doc) => ({ ...doc, upper: doc.name.toUpperCase() }),
});

const posts = defineCollection({
  name: "posts",
  directory: "posts",
  include: "*.md",
  schema: s.object({
    title: s.string(),
    featured: s.boolean().optional(),
    author: s.reference("authors", { embed: true }),
    published: s.coerce.date(),
  }),
  transform: (doc) => {
    expectTypeOf(doc.author).toExtend<string>();
    return { ...doc, permalink: `/${doc.title}` };
  },
});

const content = [authors, posts] as const;
const { defineView: boundView } = createDerivedHelpers(content);

const featured = boundView({
  name: "featured",
  from: posts,
  where: (doc): doc is typeof doc & { featured: true } => doc.featured === true,
});

const byAuthor = boundView({
  name: "byAuthor",
  from: posts,
  select: (doc) => ({ title: doc.title, author: doc.author.upper }),
});

const plain = defineView({ name: "plain", from: posts });

const config = defineConfig({
  localization: {
    strategy: "folder",
    locales: ["en", "de"],
    defaultLocale: "en",
  },
  content,
  views: [featured, byAuthor, plain],
});

describe("generated types", () => {
  it("types embeds as the final target document (transform fields included)", () => {
    type Post = GetTypeByName<typeof config, "posts">;
    expectTypeOf<Post["author"]["upper"]>().toEqualTypeOf<string>();
    expectTypeOf<Post["permalink"]>().toEqualTypeOf<string>();
    expectTypeOf<Post["published"]>().toEqualTypeOf<Date>();
    expectTypeOf<Post["_meta"]["locale"]>().toEqualTypeOf<"en" | "de">();
    expectTypeOf<
      GetTypeByName<typeof config, "authors">["_meta"]["locale"]
    >().toEqualTypeOf<undefined>();
  });

  it("keeps type-predicate narrowing in bound helpers", () => {
    expectTypeOf<
      GetViewByName<typeof config, "featured">["featured"]
    >().toEqualTypeOf<true>();
    expectTypeOf<GetViewByName<typeof config, "byAuthor">>().toEqualTypeOf<{
      title: string;
      author: string;
    }>();
  });

  it("does not collapse a transform without _meta to never", () => {
    const tags = defineCollection({
      name: "tags",
      directory: "t",
      include: "*.yml",
      schema: s.object({ label: s.string() }),
      transform: (doc) => ({ label: doc.label, size: doc.label.length }),
    });
    const tagConfig = defineConfig({ content: [tags] });
    expectTypeOf<
      GetTypeByName<typeof tagConfig, "tags">["size"]
    >().toEqualTypeOf<number>();
  });
});
