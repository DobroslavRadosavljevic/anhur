import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { getAuthor } from "anhur/generated";
import { FeatureBadges } from "~/components/feature-badges";
import { buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/authors/$id")({
  loader: async ({ params }) => {
    try {
      const author = await getAuthor({ id: params.id });
      return { author };
    } catch {
      throw notFound();
    }
  },
  component: AuthorDetail,
});

function AuthorDetail() {
  const { author } = Route.useLoaderData();

  return (
    <article className="space-y-6">
      <Link
        to="/authors"
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
      >
        ← Authors
      </Link>
      <div className="flex items-start gap-4">
        {author.avatar ? (
          <img
            src={author.avatar.src}
            alt=""
            className="size-24 rounded-xl border object-cover"
          />
        ) : null}
        <div className="space-y-2">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            {author.name}
          </h1>
          <p className="text-muted-foreground">{author.role}</p>
          <FeatureBadges items={["getAuthor()", "yaml", "localized: false"]} />
        </div>
      </div>
      <p className="max-w-2xl text-sm leading-relaxed">{author.bio}</p>
      <p className="text-muted-foreground font-mono text-xs">
        id: {author._meta.id} · {author._meta.relativePath}
      </p>
    </article>
  );
}
