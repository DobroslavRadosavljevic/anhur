import { describe, expectTypeOf, it } from "vitest";
import {
  createDerivedHelpers,
  defineCollection,
  defineConfig,
  defineGroup,
  defineIndex,
  defineView,
  type GetTypeByName,
  type GetViewByName,
  type OmitListFields,
} from "../../src/config";
import { schema as s } from "../../src/schema";

const providers = defineCollection({
  name: "providers",
  directory: "content/providers",
  include: "**/*.json",
  localized: false,
  schema: s.object({
    name: s.string(),
    slug: s.slug(),
    body: s.raw(),
  }),
});

const proxies = defineCollection({
  name: "proxies",
  directory: "content/proxies",
  include: "**/*.json",
  localized: false,
  generate: { split: "list-only" },
  schema: s.object({
    name: s.string(),
    slug: s.slug(),
    kind: s.string(),
    featured: s.boolean().optional(),
    body: s.raw(),
    provider: s.reference("providers", { embed: true }),
    categories: s.array(s.reference("providers", { embed: true })),
  }),
});

const content = [providers, proxies] as const;

describe("view embed remapping", () => {
  it("GetViewByName remaps embeds like GetTypeByName", () => {
    const proxiesByProvider = defineGroup({
      name: "proxiesByProvider",
      from: proxies,
      by: (doc) => doc.kind,
    });
    const config = defineConfig({
      content: [providers, proxies],
      views: [proxiesByProvider],
    });

    type Proxy = GetTypeByName<typeof config, "proxies">;
    type GroupItem = GetViewByName<typeof config, "proxiesByProvider">;

    expectTypeOf<GroupItem["provider"]>().toEqualTypeOf<Proxy["provider"]>();
    expectTypeOf<GroupItem["provider"]["slug"]>().toEqualTypeOf<string>();
    expectTypeOf<
      GroupItem["categories"][number]["slug"]
    >().toEqualTypeOf<string>();
  });

  it("view items without select are assignable to collection list items", () => {
    const featuredProxies = defineView({
      name: "featuredProxies",
      from: proxies,
      where: (doc) => doc.featured === true,
    });
    const config = defineConfig({
      content: [providers, proxies],
      views: [featuredProxies],
    });

    type Proxy = GetTypeByName<typeof config, "proxies">;
    type ProxyListItem = OmitListFields<Proxy, "body">;
    type Featured = GetViewByName<typeof config, "featuredProxies">;
    type FeaturedListItem = OmitListFields<Featured, "body">;

    expectTypeOf<FeaturedListItem>().toMatchTypeOf<ProxyListItem>();
    expectTypeOf<ProxyListItem["provider"]>().not.toHaveProperty("body");
    expectTypeOf<ProxyListItem["categories"][number]>().not.toHaveProperty(
      "body",
    );
    // SAFETY: preserves the existing runtime contract for this assignment.
    const _assign: ProxyListItem[] = [] as FeaturedListItem[];
    void _assign;
  });

  it("content option remaps embeds in by / where / select callbacks", () => {
    defineGroup({
      name: "proxiesByProvider",
      content,
      from: proxies,
      by: (doc) => {
        expectTypeOf(doc.provider.slug).toEqualTypeOf<string>();
        return doc.provider.slug;
      },
      where: (doc) => {
        expectTypeOf(doc.categories[0]!.slug).toEqualTypeOf<string>();
        return doc.kind === "residential";
      },
      select: (doc) => ({
        name: doc.name,
        providerSlug: doc.provider.slug,
      }),
    });

    defineIndex({
      name: "proxyBySlug",
      content,
      from: proxies,
      key: "slug",
      select: (doc) => ({
        name: doc.name,
        providerSlug: doc.provider.slug,
      }),
    });

    defineView({
      name: "featuredProxies",
      content,
      from: proxies,
      where: (doc) => doc.provider.slug.length > 0,
      select: (doc) => ({
        name: doc.name,
        providerSlug: doc.provider.slug,
      }),
    });
  });

  it("createDerivedHelpers remaps embeds without repeating content", () => {
    const { defineGroup: group, defineView: view } =
      createDerivedHelpers(content);

    group({
      name: "proxiesByProvider",
      from: proxies,
      by: (doc) => {
        expectTypeOf(doc.provider.slug).toEqualTypeOf<string>();
        return doc.provider.slug;
      },
    });

    view({
      name: "featuredProxies",
      from: proxies,
      where: (doc) => doc.featured === true,
      select: (doc) => ({
        name: doc.name,
        providerSlug: doc.provider.slug,
      }),
    });
  });

  it("index values remap embeds when there is no select", () => {
    const proxyBySlug = defineIndex({
      name: "proxyBySlug",
      from: proxies,
      key: "slug",
    });
    const config = defineConfig({
      content: [providers, proxies],
      views: [proxyBySlug],
    });

    type Indexed = GetViewByName<typeof config, "proxyBySlug">;
    expectTypeOf<Indexed["provider"]["slug"]>().toEqualTypeOf<string>();
  });
});
