import { Link, createFileRoute } from "@tanstack/react-router";
import { allPosts } from "anhur/generated";
import { FeatureBadges } from "~/components/feature-badges";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/posts/")({
  component: PostsPage,
});

function PostsPage() {
  const locales = [
    ...new Set(allPosts.map((p) => p._meta.locale ?? "default")),
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Posts
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Localized MDX collection. Cover and attachment use schema helpers;
          body images/links are rewritten when <code>assets()</code> is
          registered. Transform adds <code>permalink</code>.
        </p>
        <FeatureBadges
          items={[
            "m.mdx()",
            "a.image()",
            "a.file()",
            "s.unique()",
            "schema.transform",
            "body assets",
            "allPosts light",
            "getPost()",
          ]}
        />
      </div>

      <Tabs defaultValue={locales[0]}>
        <TabsList>
          {locales.map((locale) => (
            <TabsTrigger key={locale} value={locale}>
              {locale}
            </TabsTrigger>
          ))}
        </TabsList>
        {locales.map((locale) => {
          const posts = allPosts.filter(
            (p) => (p._meta.locale ?? "default") === locale,
          );
          return (
            <TabsContent key={locale} value={locale} className="space-y-3">
              {posts.map((post) => (
                <Card key={`${post._meta.locale}-${post._meta.id}`}>
                  <CardHeader className="flex flex-row gap-4 space-y-0">
                    {post.cover ? (
                      <img
                        src={post.cover.src}
                        alt=""
                        width={post.cover.width || 160}
                        height={post.cover.height || 90}
                        className="h-20 w-32 rounded-md border object-cover"
                        style={
                          post.cover.blurDataURL
                            ? {
                                backgroundImage: `url(${post.cover.blurDataURL})`,
                                backgroundSize: "cover",
                              }
                            : undefined
                        }
                      />
                    ) : null}
                    <div className="min-w-0 flex-1 space-y-1">
                      <CardTitle className="text-lg">{post.title}</CardTitle>
                      <CardDescription>{post.summary}</CardDescription>
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        <Badge variant="outline">{post.slug}</Badge>
                        <Badge variant="outline">{post.permalink}</Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Link
                      to="/posts/$locale/$slug"
                      params={{
                        locale: String(post._meta.locale ?? "en"),
                        slug: post.slug,
                      }}
                      className={cn(buttonVariants({ size: "sm" }))}
                    >
                      View post
                    </Link>
                  </CardContent>
                </Card>
              ))}
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
