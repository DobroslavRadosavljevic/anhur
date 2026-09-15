import { Link, createFileRoute } from "@tanstack/react-router";
import {
  about,
  allAuthors,
  allChangelogs,
  allPages,
  allPosts,
  allProducts,
  allSettings,
  settings,
} from "anhur/generated";
import { FeatureBadges } from "~/components/feature-badges";
import { buttonVariants } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/")({
  component: Home,
});

const features = [
  {
    to: "/search",
    title: "Search",
    count: null,
    description:
      "Orama full-text index built in complete — browser restore and server function over the same snapshot.",
    badges: [
      "@anhur/orama",
      "complete",
      "createSearcher",
      "searchContent()",
      "posts+pages+products+changelog",
    ],
  },
  {
    to: "/posts",
    title: "Posts",
    count: allPosts.length,
    description:
      "Localized MDX collection with cover, attachment, body rewrite, unique slug, and schema transform permalink.",
    badges: [
      "collection",
      "folder i18n",
      "allPosts light",
      "getPost()",
      "m.mdx()",
      "a.image()",
      "a.file()",
      "assets storage",
      "s.unique()",
      "schema.transform",
      "body assets",
    ],
  },
  {
    to: "/pages",
    title: "Pages",
    count: allPages.length,
    description: "Localized Markdown→HTML collection with body image rewrite.",
    badges: [
      "collection",
      "folder i18n",
      "allPages light",
      "getPage()",
      "md.markdown()",
      "body assets",
    ],
  },
  {
    to: "/authors",
    title: "Authors",
    count: allAuthors.length,
    description: "YAML collection with localized: false and optional avatars.",
    badges: [
      "collection",
      "localized: false",
      "yaml",
      "getAuthor()",
      "a.image()",
    ],
  },
  {
    to: "/products",
    title: "Products",
    count: allProducts.length,
    description: "JSON collection with unique SKU and optional brochure file.",
    badges: [
      "collection",
      "localized: false",
      "json",
      "split: list-only",
      "lookupBy: sku",
      "a.file()",
      "s.unique()",
    ],
  },
  {
    to: "/changelog",
    title: "Changelog",
    count: allChangelogs.length,
    description: "Monolingual Markdown collection (no locale folders).",
    badges: [
      "collection",
      "localized: false",
      "md.markdown()",
      "listSort",
      "getChangelog()",
    ],
  },
  {
    to: "/about",
    title: "About",
    count: 1,
    description: "Monolingual singleton via filePath + s.raw().",
    badges: ["singleton", "localized: false", "filePath", "s.raw()"],
  },
] as const;

function Home() {
  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <p className="text-muted-foreground text-sm uppercase tracking-wide">
          Anhur playground
        </p>
        <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
          {settings.siteName}
        </h1>
        <p className="text-muted-foreground max-w-2xl text-lg">
          {settings.tagline}
        </p>
        <p className="text-muted-foreground max-w-2xl whitespace-pre-wrap text-sm">
          {settings.body}
        </p>
        <FeatureBadges
          items={[
            "singleton",
            "folder i18n",
            "settings + allSettings",
            "getSettings()",
            "s.raw()",
          ]}
        />
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="font-heading text-xl font-semibold">
            Settings locales
          </h2>
          <p className="text-muted-foreground text-sm">
            Default locale export vs all-locale array.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {allSettings.map((entry) => (
            <Card key={entry._meta.locale}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  Locale {entry._meta.locale}
                </CardTitle>
                <CardDescription>{entry.siteName}</CardDescription>
              </CardHeader>
              <CardContent className="text-muted-foreground text-sm">
                {entry.tagline}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="font-heading text-xl font-semibold">Feature map</h2>
          <p className="text-muted-foreground text-sm">
            Each route dogs a Anhur capability. About title: {about.title}.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {features.map((feature) => (
            <Card key={feature.to} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle>{feature.title}</CardTitle>
                  {feature.count !== null ? (
                    <span className="text-muted-foreground text-sm tabular-nums">
                      {feature.count}
                    </span>
                  ) : null}
                </div>
                <CardDescription>{feature.description}</CardDescription>
              </CardHeader>
              <CardContent className="mt-auto space-y-4">
                <FeatureBadges items={[...feature.badges]} />
                {feature.to === "/search" ? (
                  <Link
                    to="/search"
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                    )}
                  >
                    Open
                  </Link>
                ) : feature.to === "/posts" ? (
                  <Link
                    to="/posts"
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                    )}
                  >
                    Open
                  </Link>
                ) : feature.to === "/pages" ? (
                  <Link
                    to="/pages"
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                    )}
                  >
                    Open
                  </Link>
                ) : feature.to === "/authors" ? (
                  <Link
                    to="/authors"
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                    )}
                  >
                    Open
                  </Link>
                ) : feature.to === "/products" ? (
                  <Link
                    to="/products"
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                    )}
                  >
                    Open
                  </Link>
                ) : feature.to === "/changelog" ? (
                  <Link
                    to="/changelog"
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                    )}
                  >
                    Open
                  </Link>
                ) : (
                  <Link
                    to="/about"
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                    )}
                  >
                    Open
                  </Link>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
