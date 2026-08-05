import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { getPage } from "anhur/generated";
import { FeatureBadges } from "~/components/feature-badges";
import { Badge } from "~/components/ui/badge";
import { buttonVariants } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/pages/$locale/$slug")({
  loader: async ({ params }) => {
    const page = await getPage({
      locale: params.locale,
      slug: params.slug,
    });
    if (!page) throw notFound();
    return { page };
  },
  component: PageDetail,
});

function PageDetail() {
  const { page } = Route.useLoaderData();

  return (
    <article className="space-y-6">
      <div className="space-y-3">
        <Link
          to="/pages"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
        >
          ← Pages
        </Link>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          {page.title}
        </h1>
        <div className="flex flex-wrap gap-1.5">
          <Badge>{page._meta.locale}</Badge>
          <Badge variant="outline">{page.slug}</Badge>
        </div>
        <FeatureBadges
          items={["getPage()", "md.markdown()", "HTML body", "body assets"]}
        />
      </div>
      <Separator />
      <div
        className="prose-anhur"
        dangerouslySetInnerHTML={{ __html: page.body }}
      />
    </article>
  );
}
