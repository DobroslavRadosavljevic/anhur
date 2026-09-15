import {
  Link,
  createFileRoute,
  notFound,
  useLoaderData,
} from "@tanstack/react-router";
import { MDXContent } from "@anhur/mdx/react";
import { getPost } from "anhur/generated";
import { FeatureBadges } from "~/components/feature-badges";
import { Badge } from "~/components/ui/badge";
import { buttonVariants } from "~/components/ui/button";
import { Img } from "~/components/ui/img";
import { Separator } from "~/components/ui/separator";
import { isLocale } from "~/lib/locale";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/posts/$locale/$slug")({
  loader: async ({ params }) => {
    if (!isLocale(params.locale)) throw notFound();
    const post = await getPost({
      locale: params.locale,
      slug: params.slug,
    });
    if (!post) throw notFound();
    return { post };
  },
  component: PostDetailPage,
});

function PostDetailPage() {
  const { post } = useLoaderData({ from: "/posts/$locale/$slug" });

  return (
    <article className="space-y-6">
      <div className="space-y-3">
        <Link
          to="/posts"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
        >
          ← Posts
        </Link>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          {post.title}
        </h1>
        {post.summary ? (
          <p className="text-muted-foreground">{post.summary}</p>
        ) : null}
        {post.excerpt ? (
          <p className="text-muted-foreground text-sm italic">{post.excerpt}</p>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <Badge>{post._meta.locale}</Badge>
          <Badge variant="outline">{post.slug}</Badge>
          <Badge variant="outline">{post.permalink}</Badge>
          {post.metadata ? (
            <Badge variant="outline">
              {post.metadata.readingTime} min · {post.metadata.wordCount} words
            </Badge>
          ) : null}
          {post.publishedAt ? (
            <Badge variant="outline">{post.publishedAt.slice(0, 10)}</Badge>
          ) : null}
          <Badge variant="secondary">{post.author.name}</Badge>
        </div>
        <FeatureBadges
          items={[
            "getPost()",
            "s.reference(embed)",
            "transform.documents()",
            "s.excerpt/metadata/toc",
            "m.mdx()",
            "cover meta",
            "body rewrite",
            "attachment",
          ]}
        />
      </div>

      {post.toc.length > 0 ? (
        <nav className="rounded-xl border p-4 text-sm">
          <p className="mb-2 font-medium">On this page</p>
          <ul className="space-y-1">
            {post.toc.map((entry) => (
              <li key={entry.url}>
                <a href={entry.url} className="underline underline-offset-4">
                  {entry.title}
                </a>
                {entry.items.length > 0 ? (
                  <ul className="mt-1 ml-3 space-y-1">
                    {entry.items.map((child) => (
                      <li key={child.url}>
                        <a
                          href={child.url}
                          className="text-muted-foreground underline underline-offset-4"
                        >
                          {child.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {post.cover ? (
        <Img
          src={post.cover.src}
          alt=""
          width={post.cover.width || undefined}
          height={post.cover.height || undefined}
          className="max-h-80 w-full rounded-xl border object-cover"
        />
      ) : null}

      {post.remoteCover ? (
        <div className="space-y-1">
          <p className="text-muted-foreground text-xs uppercase tracking-wide">
            Remote a.image() pass-through
          </p>
          <Img
            src={post.remoteCover.src}
            alt=""
            className="max-h-40 rounded-lg border"
          />
        </div>
      ) : null}

      {post.attachment ? (
        <p className="text-sm">
          Attachment:{" "}
          <a
            href={post.attachment.src}
            className="underline underline-offset-4"
            target="_blank"
            rel="noreferrer"
          >
            {post.attachment.src}
          </a>
        </p>
      ) : null}

      <Separator />

      <div className="prose-anhur">
        <MDXContent code={post.body} />
      </div>
    </article>
  );
}
