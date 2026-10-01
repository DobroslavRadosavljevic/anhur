import { describe, expectTypeOf, it } from "vitest";
import {
  createDerivedHelpers,
  defineCollection,
  defineConfig,
  defineIndex,
  defineView,
  schema as s,
  type GetTypeByName,
  type GetViewByName,
} from "../../src";

const authors = defineCollection({
  name: "authors",
  directory: "authors",
  include: "*.yml",
  schema: s.object({ name: s.string() }),
});

const links = defineCollection({
  name: "links",
  directory: "links",
  include: "*.yml",
  schema: s.discriminatedUnion("kind", [
    s.object({ kind: s.literal("link"), url: s.string() }),
    s.object({
      kind: s.literal("post"),
      author: s.reference("authors", { embed: true }),
    }),
    s.object({ kind: s.literal("guest"), author: s.string() }),
  ]),
});

const renamed = defineCollection({
  name: "renamed",
  directory: "renamed",
  include: "*.md",
  schema: s.object({
    title: s.string(),
    author: s.reference("authors", { embed: true }),
  }),
  transform: ({ author, ...rest }) => ({ ...rest, writer: author }),
});

const rebuilt = defineCollection({
  name: "rebuilt",
  directory: "rebuilt",
  include: "*.md",
  schema: s.object({ author: s.reference("authors", { embed: true }) }),
  transform: (doc) => ({ author: String(doc.author), count: 1 }),
});

const content = [authors, links, renamed, rebuilt] as const;
const config = defineConfig({ content });

describe("generated types for unions and transforms", () => {
  it("keeps variant-only fields of discriminated unions (H1)", () => {
    type Link = GetTypeByName<typeof config, "links">;
    const read = (link: Link) => {
      if (link.kind === "link") expectTypeOf(link.url).toEqualTypeOf<string>();
      if (link.kind === "post") {
        expectTypeOf(link.author.name).toEqualTypeOf<string>();
      }
      if (link.kind === "guest") {
        expectTypeOf(link.author).toEqualTypeOf<string>();
      }
    };
    expectTypeOf(read).toBeFunction();
  });

  it("types embeds where the relations pass embeds them (M2)", () => {
    type Renamed = GetTypeByName<typeof config, "renamed">;
    expectTypeOf<Renamed["writer"]>().toEqualTypeOf<string>();
    type Rebuilt = GetTypeByName<typeof config, "rebuilt">;
    expectTypeOf<Rebuilt["author"]["name"]>().toEqualTypeOf<string>();
    expectTypeOf<Rebuilt["count"]>().toEqualTypeOf<number>();
  });
});

describe("plain derived helpers (M8)", () => {
  const posts = defineCollection({
    name: "posts",
    directory: "posts",
    include: "*.md",
    schema: s.object({
      title: s.string(),
      author: s.reference("authors", { embed: true }),
    }),
  });

  it("does not type embedded documents as string ids", () => {
    defineView({
      name: "titles",
      from: posts,
      select: (doc) => {
        expectTypeOf(doc.author).not.toExtend<string>();
        return { title: doc.title };
      },
    });
    defineIndex({ name: "byTitle", from: posts, key: "title" });
    // @ts-expect-error -- an embedded document is not a string key
    defineIndex({ name: "byAuthor", from: posts, key: "author" });
  });

  it("still types embeds as documents in generated view types", () => {
    const withAuthor = defineView({
      name: "withAuthor",
      from: posts,
      select: (doc) => ({ title: doc.title, author: doc.author }),
    });
    const viewConfig = defineConfig({
      content: [authors, posts],
      views: [withAuthor],
    });
    expectTypeOf<
      GetViewByName<typeof viewConfig, "withAuthor">["author"]["name"]
    >().toEqualTypeOf<string>();
    const { defineView: boundView } = createDerivedHelpers([authors, posts]);
    boundView({
      name: "bound",
      from: posts,
      where: (doc) => doc.author.name.length > 0,
    });
  });
});
