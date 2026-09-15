import { describe, expectTypeOf, it } from "vitest";
import {
  defineCollection,
  defineConfig,
  defineGroup,
  defineIndex,
  defineView,
  type DerivedName,
  type GetViewByName,
  type InferViewData,
  type ViewContext,
} from "../../src/config";
import { schema as s } from "../../src/schema";
import configuration from "../fixtures/codegen-views/anhur.config";

type FeaturedPost = GetViewByName<typeof configuration, "featuredPosts">;
type FeaturedProduct = GetViewByName<typeof configuration, "featuredProducts">;
type SiteFeed = GetViewByName<typeof configuration, "siteFeed">;
type ProductBySku = GetViewByName<typeof configuration, "productBySku">;
type ProductsByCategory = GetViewByName<
  typeof configuration,
  "productsByCategory"
>;

describe("GetViewByName resolved types", () => {
  it("narrows featured via type predicate where", () => {
    expectTypeOf<FeaturedPost["featured"]>().toEqualTypeOf<true>();
    expectTypeOf<FeaturedPost["title"]>().toEqualTypeOf<string>();
    expectTypeOf<FeaturedPost["slug"]>().toEqualTypeOf<string>();
    expectTypeOf<FeaturedPost["body"]>().toEqualTypeOf<string>();
    expectTypeOf<FeaturedPost["_meta"]["id"]>().toEqualTypeOf<string>();
  });

  it("keeps optional boolean when where is not a type predicate", () => {
    expectTypeOf<FeaturedProduct["featured"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<FeaturedProduct["sku"]>().toEqualTypeOf<string>();
    expectTypeOf<FeaturedProduct["_meta"]["id"]>().toEqualTypeOf<string>();
    expectTypeOf<
      FeaturedProduct["_meta"]["locale"]
    >().toEqualTypeOf<undefined>();
  });

  it("keeps locale on localized view items", () => {
    expectTypeOf<FeaturedPost["_meta"]["locale"]>().toEqualTypeOf<"en">();
  });

  it("uses select() return type for merged views", () => {
    expectTypeOf<SiteFeed>().toEqualTypeOf<{
      collection: "posts" | "pages";
      title: string;
      slug: string;
      href: string;
    }>();
  });

  it("uses select() return type for indexes and groups", () => {
    expectTypeOf<ProductBySku>().toEqualTypeOf<{
      name: string;
      sku: string;
      price: string;
    }>();
    expectTypeOf<ProductsByCategory>().toEqualTypeOf<{
      name: string;
      sku: string;
      price: string;
    }>();
  });

  it("constrains GetViewByName names to configured derived exports", () => {
    type Names = DerivedName<typeof configuration>;
    expectTypeOf<Names>().toEqualTypeOf<
      | "featuredPosts"
      | "featuredProducts"
      | "siteFeed"
      | "productBySku"
      | "productsByCategory"
    >();
  });

  it("list omit wrapper matches generated FeaturedPost d.ts shape", () => {
    type FeaturedPostListItem = import("../../src/config").OmitListFields<
      FeaturedPost,
      "body"
    >;
    expectTypeOf<FeaturedPostListItem>().not.toHaveProperty("body");
    expectTypeOf<FeaturedPostListItem["featured"]>().toEqualTypeOf<true>();
    expectTypeOf<FeaturedPostListItem["title"]>().toEqualTypeOf<string>();
  });
});

describe("defineView / defineIndex / defineGroup config typing", () => {
  const posts = defineCollection({
    name: "posts",
    directory: "content/posts",
    include: "**/*.md",
    schema: s.object({
      title: s.string(),
      slug: s.string(),
      featured: s.boolean().optional(),
      category: s.string(),
    }),
  });

  it("types key/by as string document fields", () => {
    defineIndex({
      name: "bySlug",
      from: posts,
      key: "slug",
    });
    defineGroup({
      name: "byCategory",
      from: posts,
      by: "category",
    });

    defineIndex({
      name: "badKey",
      from: posts,
      // @ts-expect-error not a document field
      key: "doesNotExist",
    });
  });

  it("narrows select input after type-predicate where", () => {
    const view = defineView({
      name: "featuredOnly",
      from: posts,
      where: (doc): doc is typeof doc & { featured: true } =>
        doc.featured === true,
      select: (doc) => {
        expectTypeOf(doc.featured).toEqualTypeOf<true>();
        return { title: doc.title, featured: doc.featured };
      },
    });

    type Item = InferViewData<typeof view>;
    expectTypeOf<Item>().toEqualTypeOf<{
      title: string;
      featured: true;
    }>();
  });

  it("types ViewContext.documents from a collection object", () => {
    defineView({
      name: "withCtx",
      from: posts,
      select: (doc, ctx: ViewContext) => {
        const related = ctx.documents(posts);
        expectTypeOf(related[0]!).toMatchTypeOf<{
          title: string;
          slug: string;
          _meta: { id: string };
        }>();
        return { title: doc.title, related: related.length };
      },
    });
  });

  it("preserves item types through defineConfig views tuple", () => {
    const bySlug = defineIndex({
      name: "postBySlug",
      from: posts,
      key: "slug",
      select: (doc) => ({ slug: doc.slug, title: doc.title }),
    });
    const config = defineConfig({
      content: [posts],
      views: [bySlug],
    });
    type Item = GetViewByName<typeof config, "postBySlug">;
    expectTypeOf<Item>().toEqualTypeOf<{ slug: string; title: string }>();
  });
});
