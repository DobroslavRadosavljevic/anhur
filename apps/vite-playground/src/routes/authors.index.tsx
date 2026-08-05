import { Link, createFileRoute } from "@tanstack/react-router";
import { allAuthors } from "anhur/generated";
import { FeatureBadges } from "~/components/feature-badges";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/authors/")({
  component: AuthorsPage,
});

function AuthorsPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Authors
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          YAML collection with <code>localized: false</code> — one set of files,
          no locale folders.
        </p>
        <FeatureBadges
          items={["yaml loader", "localized: false", "a.image().optional()"]}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {allAuthors.map((author) => (
          <Card key={author._meta.id}>
            <CardHeader className="flex flex-row gap-4 space-y-0">
              {author.avatar ? (
                <img
                  src={author.avatar.src}
                  alt=""
                  width={author.avatar.width || 64}
                  height={author.avatar.height || 64}
                  className="size-16 rounded-full border object-cover"
                />
              ) : (
                <div className="bg-muted text-muted-foreground flex size-16 items-center justify-center rounded-full border text-xs">
                  N/A
                </div>
              )}
              <div>
                <CardTitle>{author.name}</CardTitle>
                <CardDescription>{author.role}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-muted-foreground text-sm">{author.bio}</p>
              <Link
                to="/authors/$id"
                params={{ id: author._meta.id }}
                className={cn(
                  buttonVariants({ size: "sm", variant: "outline" }),
                )}
              >
                Details
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
